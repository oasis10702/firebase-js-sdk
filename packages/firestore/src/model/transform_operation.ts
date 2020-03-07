/**
 * @license
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as api from '../protos/firestore_proto_api';

import { Timestamp } from '../api/timestamp';
import { assert } from '../util/assert';
import {
  equals,
  isArray,
  isDouble,
  isInteger,
  isNumber,
  normalizeNumber
} from './values';
import { valueOf } from './server_timestamps';
import { isSafeInteger } from '../util/types';

/** Represents a transform within a TransformMutation. */
export interface TransformOperation {
  /**
   * Computes the local transform result against the provided `previousValue`,
   * optionally using the provided localWriteTime.
   */
  applyToLocalView(
    previousValue: api.Value | null,
    localWriteTime: Timestamp
  ): api.Value;

  /**
   * Computes a final transform result after the transform has been acknowledged
   * by the server, potentially using the server-provided transformResult.
   */
  applyToRemoteDocument(
    previousValue: api.Value | null,
    transformResult: api.Value | null
  ): api.Value;

  /**
   * If this transform operation is not idempotent, returns the base value to
   * persist for this transform. If a base value is returned, the transform
   * operation is always applied to this base value, even if document has
   * already been updated.
   *
   * Base values provide consistent behavior for non-idempotent transforms and
   * allow us to return the same latency-compensated value even if the backend
   * has already applied the transform operation. The base value is null for
   * idempotent transforms, as they can be re-played even if the backend has
   * already applied them.
   *
   * @return a base value to store along with the mutation, or null for
   * idempotent transforms.
   */
  computeBaseValue(previousValue: api.Value | null): api.Value | null;

  isEqual(other: TransformOperation): boolean;
}

/** Transforms a value into a server-generated timestamp. */
export class ServerTimestampTransform implements TransformOperation {
  private constructor() {}
  static instance = new ServerTimestampTransform();

  applyToLocalView(
    previousValue: api.Value | null,
    localWriteTime: Timestamp
  ): api.Value {
    return valueOf(localWriteTime!, previousValue);
  }

  applyToRemoteDocument(
    previousValue: api.Value | null,
    transformResult: api.Value | null
  ): api.Value {
    return transformResult!;
  }

  computeBaseValue(previousValue: api.Value | null): api.Value | null {
    return null; // Server timestamps are idempotent and don't require a base value.
  }

  isEqual(other: TransformOperation): boolean {
    return other instanceof ServerTimestampTransform;
  }
}

/** Transforms an array value via a union operation. */
export class ArrayUnionTransformOperation implements TransformOperation {
  constructor(readonly elements: api.Value[]) {}

  applyToLocalView(
    previousValue: api.Value | null,
    localWriteTime: Timestamp
  ): api.Value {
    return this.apply(previousValue);
  }

  applyToRemoteDocument(
    previousValue: api.Value | null,
    transformResult: api.Value | null
  ): api.Value {
    // The server just sends null as the transform result for array operations,
    // so we have to calculate a result the same as we do for local
    // applications.
    return this.apply(previousValue);
  }

  private apply(previousValue: api.Value | null): api.Value {
    const values = coercedFieldValuesArray(previousValue);
    for (const toUnion of this.elements) {
      if (!values.find(element => equals(element, toUnion))) {
        values.push(toUnion);
      }
    }
    return { arrayValue: { values } };
  }

  computeBaseValue(previousValue: api.Value | null): api.Value | null {
    return null; // Array transforms are idempotent and don't require a base value.
  }

  isEqual(other: TransformOperation): boolean {
    return (
      other instanceof ArrayUnionTransformOperation &&
      equals(
        { arrayValue: { values: this.elements } },
        { arrayValue: { values: other.elements } }
      )
    );
  }
}

/** Transforms an array value via a remove operation. */
export class ArrayRemoveTransformOperation implements TransformOperation {
  constructor(readonly elements: api.Value[]) {}

  applyToLocalView(
    previousValue: api.Value | null,
    localWriteTime: Timestamp
  ): api.Value {
    return this.apply(previousValue);
  }

  applyToRemoteDocument(
    previousValue: api.Value | null,
    transformResult: api.Value | null
  ): api.Value {
    // The server just sends null as the transform result for array operations,
    // so we have to calculate a result the same as we do for local
    // applications.
    return this.apply(previousValue);
  }

  private apply(previousValue: api.Value | null): api.Value {
    let values = coercedFieldValuesArray(previousValue);
    for (const toRemove of this.elements) {
      values = values.filter(element => !equals(element, toRemove));
    }
    return { arrayValue: { values } };
  }

  computeBaseValue(previousValue: api.Value | null): api.Value | null {
    return null; // Array transforms are idempotent and don't require a base value.
  }

  isEqual(other: TransformOperation): boolean {
    return (
      other instanceof ArrayRemoveTransformOperation &&
      equals(
        { arrayValue: { values: this.elements } },
        { arrayValue: { values: other.elements } }
      )
    );
  }
}

/**
 * Implements the backend semantics for locally computed NUMERIC_ADD (increment)
 * transforms. Converts all field values to integers or doubles, but unlike the
 * backend does not cap integer values at 2^63. Instead, JavaScript number
 * arithmetic is used and precision loss can occur for values greater than 2^53.
 */
export class NumericIncrementTransformOperation implements TransformOperation {
  constructor(readonly operand: api.Value, readonly useProto3Json: string) {
    assert(isNumber(operand), 'NUMERIC_ADD transform requires a NumberValue');
  }

  applyToLocalView(
    previousValue: api.Value | null,
    localWriteTime: Timestamp
  ): api.Value {
    const baseValue = this.asNumber(this.computeBaseValue(previousValue));
    // PORTING NOTE: Since JavaScript's integer arithmetic is limited to 53 bit
    // precision and resolves overflows by reducing precision, we do not
    // manually cap overflows at 2^63.

    // Return an integer value iff the previous value and the operand is an
    // integer.
    if (isSafeInteger(baseValue) && isInteger(this.operand)) {
      const integerValue = baseValue + this.asNumber(this.operand);
      return { integerValue };
    } else {
      const doubleValue = baseValue + this.asNumber(this.operand);

      if (isNaN(doubleValue)) {
        return { doubleValue: 'NaN' };
      } else if (doubleValue === Infinity) {
        return { doubleValue: 'Infinity' };
      } else if (doubleValue === -Infinity) {
        return { doubleValue: '-Infinity' };
      }
      return { doubleValue };
    }
  }

  applyToRemoteDocument(
    previousValue: api.Value | null,
    transformResult: api.Value | null
  ): api.Value {
    assert(
      transformResult !== null,
      "Didn't receive transformResult for NUMERIC_ADD transform"
    );
    return transformResult;
  }

  /**
   * Inspects the provided value, returning the provided value if it is already
   * a NumberValue, otherwise returning a coerced value 0.
   */
  computeBaseValue(previousValue: api.Value | null): api.Value {
    return isNumber(previousValue) ? previousValue! : { integerValue: 0 };
  }

  isEqual(other: TransformOperation): boolean {
    return (
      other instanceof NumericIncrementTransformOperation &&
      equals(this.operand, other.operand)
    );
  }

  private asNumber(value: api.Value): number {
    if (isDouble(value)) {
      return normalizeNumber(value.doubleValue);
    } else {
      return normalizeNumber(value.integerValue);
    }
  }
}

function coercedFieldValuesArray(value: api.Value | null): api.Value[] {
  if (isArray(value)) {
    return value!.arrayValue?.values || [];
  } else {
    // coerce to empty array.
    return [];
  }
}
