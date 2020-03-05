/**
 * @license
 * Copyright 2017 Google Inc.
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

import { GeoPoint } from '../api/geo_point';
import { Timestamp } from '../api/timestamp';
import { DatabaseId } from '../core/database_info';
import { assert, fail } from '../util/assert';
import { DocumentKey } from './document_key';
import { FieldMask } from './mutation';
import { FieldPath, ResourcePath } from './path';
import { SortedSet } from '../util/sorted_set';
import * as api from '../protos/firestore_proto_api';
import {
  canonicalId,
  compare,
  equals,
  estimateByteSize,
  normalizeByteString,
  normalizeTimestamp, typeOrder
} from './proto_values';
import { Blob } from '../api/blob';
import { forEach } from '../util/obj';

/**
 * Supported data value types:
 *  - Null
 *  - Boolean
 *  - Long
 *  - Double
 *  - String
 *  - Object
 *  - Array
 *  - Binary
 *  - Timestamp
 *  - ServerTimestamp (a sentinel used in uncommitted writes)
 *  - GeoPoint
 *  - (Document) References
 */

export interface JsonObject<T> {
  [name: string]: T;
}

export enum TypeOrder {
  // This order is defined by the backend.
  NullValue = 0,
  BooleanValue = 1,
  NumberValue = 2,
  TimestampValue = 3,
  StringValue = 4,
  BlobValue = 5,
  RefValue = 6,
  GeoPointValue = 7,
  ArrayValue = 8,
  ObjectValue = 9
}

/**
 * Potential types returned by FieldValue.value(). This could be stricter
 * (instead of using {}), but there's little benefit.
 *
 * Note that currently we use `unknown` (which is identical except includes
 * undefined) for incoming user data as a convenience to the calling code (but
 * we'll throw if the data contains undefined). This should probably be changed
 * to use FieldType, but all consuming code will have to be updated to
 * explicitly handle undefined and then cast to FieldType or similar. Perhaps
 * we should tackle this when adding robust argument validation to the API.
 */
export type FieldType = null | boolean | number | string | {};

/**
 * Represents a FieldValue that is backed by a single Firestore V1 Value proto
 * and implements Firestore's Value semantics for ordering and equality.
 */
export class FieldValue {
  protected constructor(public readonly proto: api.Value) {}

  // TODO(mrschmidt): Unify with UserDataReader.parseScalarValue()
  static of(value: api.Value): FieldValue {
    if ('nullValue' in value) {
      return NullValue.INSTANCE;
    } else if ('booleanValue' in value) {
      return new BooleanValue(value);
    } else if ('integerValue' in value) {
      return new IntegerValue(value);

    } else if ('doubleValue' in value) {
      return new DoubleValue(value);
    } else if ('timestampValue' in value) {
      return new TimestampValue(value);
    } else if ('stringValue' in value) {
      return new StringValue(value)
    } else if ('bytesValue' in value) {
      return new BlobValue(value);
    } else if ('referenceValue' in value) {
      return new RefValue(value);
    } else if ('geoPointValue' in value) {
      return new GeoPointValue(value);
    } else if ('arrayValue' in value) {
      return new ArrayValue(value);
    } else if ('mapValue' in value) {
      if (ServerTimestampValue.isServerTimestamp(value)) {
        return new ServerTimestampValue(value);
      }
      return new ObjectValue(value);
    } else {
      return fail('Invalid value type: ' + JSON.stringify(value));
    }
  }
  
  value(): FieldType {
    return this.convertValue(this.proto);
  }

  private convertValue(value: api.Value): FieldType {
    if ('nullValue' in value) {
      return null;
    } else if ('booleanValue' in value) {
      return value.booleanValue!;
    } else if ('integerValue' in value) {
      return value.integerValue!;
    } else if ('doubleValue' in value) {
      return value.doubleValue!;
    } else if ('timestampValue' in value) {
      const normalizedTimestamp = normalizeTimestamp(value.timestampValue!);
      return new Timestamp(
        normalizedTimestamp.seconds,
        normalizedTimestamp.nanos
      );
    } else if ('stringValue' in value) {
      return value.stringValue!;
    } else if ('bytesValue' in value) {
      return new Blob(normalizeByteString(value.bytesValue!));
    } else if ('referenceValue' in value) {
      return this.convertReference(value.referenceValue!);
    } else if ('geoPointValue' in value) {
      return new GeoPoint(
        value.geoPointValue!.latitude || 0,
        value.geoPointValue!.longitude || 0
      );
    } else if ('arrayValue' in value) {
      return this.convertArray(value.arrayValue!.values || []);
    } else if ('mapValue' in value) {
      return this.convertMap(value.mapValue!.fields || {});
    } else {
      return fail('Unknown value type: ' + JSON.stringify(value));
    }
  }

  private convertReference(value: string): DocumentKey {
    // TODO(mrschmidt): Move `value()` and `convertValue()` to DocumentSnapshot,
    // which would allow us to validate that the resource name points to the
    // current project.
    const resourceName = ResourcePath.fromString(value);
    assert(
      resourceName.length > 4 && resourceName.get(4) === 'documents',
      'Tried to deserialize invalid key ' + resourceName.toString()
    );
    return new DocumentKey(resourceName.popFirst(5));
  }

  private convertArray(values: api.Value[]): unknown[] {
    return values.map(v => this.convertValue(v));
  }

  private convertMap(
    value: api.ApiClientObjectMap<api.Value>
  ): { [k: string]: unknown } {
    const result: { [k: string]: unknown } = {};
    forEach(value, (k, v) => {
      result[k] = this.convertValue(v);
    });
    return result;
  }

  approximateByteSize(): number {
    return estimateByteSize(this.proto);
  }

  isEqual(other: FieldValue): boolean {
    if (this === other) {
      return true;
    }
    return equals(this.proto, other.proto);
  }

  compareTo(other: FieldValue): number {
    return compare(this.proto, other.proto);
  }

}

export class NullValue extends FieldValue {
  typeOrder = TypeOrder.NullValue;

  value(): null {
    return null;
  }

  static INSTANCE = new NullValue({ nullValue: 'NULL_VALUE' });
}

export class BooleanValue extends FieldValue {
  typeOrder = TypeOrder.BooleanValue;
  
  static valueOf(value: boolean): BooleanValue {
    return value ? BooleanValue.TRUE : BooleanValue.FALSE;
  }

  static TRUE = new BooleanValue({ booleanValue: true });
  static FALSE = new BooleanValue({ booleanValue: false });
}

/** Base class for IntegerValue and DoubleValue. */
export abstract class NumberValue extends FieldValue {
  typeOrder = TypeOrder.NumberValue;
}

export class IntegerValue extends NumberValue {}

export class DoubleValue extends NumberValue {
  static NAN = new DoubleValue({ doubleValue: NaN });
  static POSITIVE_INFINITY = new DoubleValue({ doubleValue: Infinity });
  static NEGATIVE_INFINITY = new DoubleValue({ doubleValue: -Infinity });
}

// TODO(b/37267885): Add truncation support
export class StringValue extends FieldValue {
  typeOrder = TypeOrder.StringValue;
}

export class TimestampValue extends FieldValue {
  typeOrder = TypeOrder.TimestampValue;
}

/**
 * Represents a locally-applied ServerTimestamp.
 *
 * Server Timestamps are backed by MapValues that contain an internal field
 * `__type__` with a value of `server_timestamp`. The previous value and local
 * write time are stored in its `__previous_value__` and `__local_write_time__`
 * fields respectively.
 *
 * Notes:
 * - ServerTimestampValue instances are created as the result of applying a
 *   TransformMutation (see TransformMutation.applyTo()). They can only exist in
 *   the local view of a document. Therefore they do not need to be parsed or
 *   serialized.
 * - When evaluated locally (e.g. for snapshot.data()), they by default
 *   evaluate to `null`. This behavior can be configured by passing custom
 *   FieldValueOptions to value().
 * - With respect to other ServerTimestampValues, they sort by their
 *   localWriteTime.
 */
export class ServerTimestampValue extends FieldValue {
  private static SERVER_TIMESTAMP_SENTINEL = 'server_timestamp';
  private static TYPE_KEY = '__type__';
  private static PREVIOUS_VALUE_KEY = '__previous_value__';
  private static LOCAL_WRITE_TIME_KEY = '__local_write_time__';

  typeOrder = TypeOrder.TimestampValue;

  static isServerTimestamp(value: api.Value): boolean {
    const type = (value.mapValue?.fields || {})[ServerTimestampValue.TYPE_KEY]
      ?.stringValue;
    return type === ServerTimestampValue.SERVER_TIMESTAMP_SENTINEL;
  }

  static valueOf(
    localWriteTime: Timestamp,
    previousValue: FieldValue | null
  ): ServerTimestampValue {
    const mapValue: api.MapValue = {
      fields: {
        [ServerTimestampValue.TYPE_KEY]: {
          stringValue: ServerTimestampValue.SERVER_TIMESTAMP_SENTINEL
        },
        [ServerTimestampValue.LOCAL_WRITE_TIME_KEY]: {
          timestampValue: {
            seconds: localWriteTime.seconds,
            nanos: localWriteTime.nanoseconds
          }
        }
      }
    };

    if (previousValue) {
      mapValue.fields![ServerTimestampValue.PREVIOUS_VALUE_KEY] =
        previousValue.proto;
    }

    return new ServerTimestampValue({ mapValue });
  }

  constructor(proto: api.Value) {
    super(proto);
    assert(
      ServerTimestampValue.isServerTimestamp(proto),
      'Backing value is not a ServerTimestampValue'
    );
  }

  /**
   * Returns the value of the field before this ServerTimestamp was set.
   *
   * Preserving the previous values allows the user to display the last resoled
   * value until the backend responds with the timestamp.
   */

  get previousValue(): FieldValue | null {
    const previousValue = this.proto.mapValue!.fields![
      ServerTimestampValue.PREVIOUS_VALUE_KEY
    ];

    if (ServerTimestampValue.isServerTimestamp(previousValue)) {
      return new ServerTimestampValue(previousValue).previousValue;
    } else if (previousValue) {
      return  FieldValue.of(previousValue);
    } else {
      return null;
    }
  }

  get localWriteTime(): Timestamp {
    const localWriteTime = normalizeTimestamp(
      this.proto.mapValue!.fields![ServerTimestampValue.LOCAL_WRITE_TIME_KEY]
        .timestampValue!
    );
    return new Timestamp(localWriteTime.seconds, localWriteTime.nanos);
  }

  toString(): string {
    return '<ServerTimestamp localTime=' + this.localWriteTime.toString() + '>';
  }
}

export class BlobValue extends FieldValue {
  typeOrder = TypeOrder.BlobValue;
}

export class RefValue extends FieldValue {
  typeOrder = TypeOrder.RefValue;
  readonly databaseId: DatabaseId;
  readonly key: DocumentKey;

  constructor(proto: api.Value) {
    super(proto);

    const resourceName = ResourcePath.fromString(proto.referenceValue!);
    assert(
      resourceName.length >= 4 &&
        resourceName.get(0) === 'projects' &&
        resourceName.get(2) === 'databases' &&
        resourceName.get(4) === 'documents',
      'Tried to create ReferenceValue from invalid key: ' + resourceName
    );
    this.databaseId = new DatabaseId(resourceName.get(1), resourceName.get(3));
    this.key = new DocumentKey(resourceName.popFirst(5));
  }

  static valueOf(databaseId: DatabaseId, key: DocumentKey): RefValue {
    return new RefValue({
      referenceValue: `projects/${databaseId.projectId}/databases/${databaseId.database}/documents/${key}`
    });
  }

  approximateByteSize(): number {
    return (
      this.databaseId.projectId.length +
      this.databaseId.database.length +
      this.key.toString().length
    );
  }
}

export class GeoPointValue extends FieldValue {
  typeOrder = TypeOrder.GeoPointValue;

  approximateByteSize(): number {
    // GeoPoints are made up of two distinct numbers (latitude + longitude)
    return 16;
  }
}

/**
 * An ObjectValue represents a MapValue in the Firestore Proto and offers the
 * ability to add and remove fields (via the ObjectValueBuilder).
 */
export class ObjectValue extends FieldValue {
  static EMPTY = new ObjectValue({ mapValue: {} });

  constructor(proto: api.Value) {
    super(proto);
    assert(
      !ServerTimestampValue.isServerTimestamp(proto),
      "ServerTimestamps should be converted to ServerTimestampValue"
    );
    
  }

  /** Returns a new Builder instance that is based on an empty object. */
  static newBuilder(): ObjectValueBuilder {
    return ObjectValue.EMPTY.toBuilder();
  }

  /**
   * Returns the value at the given path or null.
   *
   * @param path the path to search
   * @return The value at the path or if there it doesn't exist.
   */
  field(path: FieldPath): FieldValue | null {
    if (path.isEmpty()) {
      return this;
    } else {
      let value = this.proto;
      for (let i = 0; i < path.length - 1; ++i) {
        if (!value.mapValue!.fields) {
          return null;
        }
        value = value.mapValue!.fields[path.get(i)];
        if (typeOrder(value) !== TypeOrder.ObjectValue) {
          return null;
        }
      }

      value = (value.mapValue!.fields || {})[path.lastSegment()];
      return FieldValue.of (value);
    }
  }

  /**
   * Returns a FieldMask built from all FieldPaths starting from this
   * ObjectValue, including paths from nested objects.
   */
  fieldMask(): FieldMask {
    return this.extractFieldMask(this.proto.mapValue!);
  }

  private extractFieldMask(value: api.MapValue): FieldMask {
    let fields = new SortedSet<FieldPath>(FieldPath.comparator);
    forEach(value.fields || {}, (key, value) => {
      const currentPath = new FieldPath([key]);
      if (typeOrder(value) ===  TypeOrder.ObjectValue) {
        const nestedMask = this.extractFieldMask(value.mapValue!);
        const nestedFields = nestedMask.fields;
        if (nestedFields.isEmpty()) {
          // Preserve the empty map by adding it to the FieldMask.
          fields = fields.add(currentPath);
        } else {
          // For nested and non-empty ObjectValues, add the FieldPath of the
          // leaf nodes.
          nestedFields.forEach(nestedPath => {
            fields = fields.add(currentPath.child(nestedPath));
          });
        }
      } else {
        // For nested and non-empty ObjectValues, add the FieldPath of the leaf
        // nodes.
        fields = fields.add(currentPath);
      }
    });
    return FieldMask.fromSet(fields);
  }

  /** Creates a ObjectValueBuilder instance that is based on the current value. */
  toBuilder(): ObjectValueBuilder {
    return new ObjectValueBuilder(this);
  }
}

/**
 * An Overlay, which contains an update to apply. Can either be Value proto, a
 * map of Overlay values (to represent additional nesting at the given key) or
 * `null` (to represent field deletes).
 */
type Overlay = Map<string, Overlay> | api.Value | null;

/**
 * An ObjectValueBuilder provides APIs to set and delete fields from an
 * ObjectValue.
 */
export class ObjectValueBuilder {
  /** A map that contains the accumulated changes in this builder. */
  private overlayMap = new Map<string, Overlay>();

  /**
   * @param baseObject The object to mutate.
   */
  constructor(private readonly baseObject: ObjectValue) {}

  /**
   * Sets the field to the provided value.
   *
   * @param path The field path to set.
   * @param value The value to set.
   * @return The current Builder instance.
   */
  set(path: FieldPath, value: api.Value): ObjectValueBuilder {
    assert(!path.isEmpty(), 'Cannot set field for empty path on ObjectValue');
    this.setOverlay(path, value);
    return this;
  }

  /**
   * Removes the field at the specified path. If there is no field at the
   * specified path, nothing is changed.
   *
   * @param path The field path to remove.
   * @return The current Builder instance.
   */
  delete(path: FieldPath): ObjectValueBuilder {
    assert(
      !path.isEmpty(),
      'Cannot delete field for empty path on ObjectValue'
    );
    this.setOverlay(path, null);
    return this;
  }

  /**
   * Adds `value` to the overlay map at `path`. Creates nested map entries if
   * needed.
   */
  private setOverlay(path: FieldPath, value: api.Value | null): void {
    let currentLevel = this.overlayMap;

    for (let i = 0; i < path.length - 1; ++i) {
      const currentSegment = path.get(i);
      let currentValue = currentLevel.get(currentSegment);

      if (currentValue instanceof Map) {
        // Re-use a previously created map
        currentLevel = currentValue;
      } else if (currentValue && typeOrder(currentValue) === TypeOrder.ObjectValue) {
        // Convert the existing Protobuf MapValue into a map
        currentValue = new Map<string, Overlay>(
          Object.entries(currentValue.mapValue!.fields || {})
        );
        currentLevel.set(currentSegment, currentValue);
        currentLevel = currentValue;
      } else {
        // Create an empty map to represent the current nesting level
        currentValue = new Map<string, Overlay>();
        currentLevel.set(currentSegment, currentValue);
        currentLevel = currentValue;
      }
    }

    currentLevel.set(path.lastSegment(), value);
  }

  /** Returns an ObjectValue with all mutations applied. */
  build(): ObjectValue {
    const mergedResult = this.applyOverlay(
      FieldPath.EMPTY_PATH,
      this.overlayMap
    );
    if (mergedResult != null) {
      return new ObjectValue(mergedResult);
    } else {
      return this.baseObject;
    }
  }

  /**
   * Applies any overlays from `currentOverlays` that exist at `currentPath`
   * and returns the merged data at `currentPath` (or null if there were no
   * changes).
   *
   * @param currentPath The path at the current nesting level. Can be set to
   * FieldValue.EMPTY_PATH to represent the root.
   * @param currentOverlays The overlays at the current nesting level in the
   * same format as `overlayMap`.
   * @return The merged data at `currentPath` or null if no modifications
   * were applied.
   */
  private applyOverlay(
    currentPath: FieldPath,
    currentOverlays: Map<string, Overlay>
  ): api.Value | null {
    let modified = false;

    const existingValue = this.baseObject.field(currentPath);
    const resultAtPath =
      existingValue instanceof ObjectValue
        ? // If there is already data at the current path, base our
          // modifications on top of the existing data.
          { ...existingValue.proto.mapValue!.fields }
        : {};

    currentOverlays.forEach((value, pathSegment) => {
      if (value instanceof Map) {
        const nested = this.applyOverlay(currentPath.child(pathSegment), value);
        if (nested != null) {
          resultAtPath[pathSegment] = nested;
          modified = true;
        }
      } else if (value !== null) {
        resultAtPath[pathSegment] = value;
        modified = true;
      } else if (resultAtPath.hasOwnProperty(pathSegment)) {
        delete resultAtPath[pathSegment];
        modified = true;
      }
    });

    return modified ? { mapValue: { fields: resultAtPath } } : null;
  }
}

export class ArrayValue extends FieldValue {
  typeOrder = TypeOrder.ArrayValue;
  
  static fromList(values: FieldValue[]) {
    return new ArrayValue({arrayValue: { values: values.map(v => v.proto)}});
  }
  
  getValues(): FieldValue[] {
    return (this.proto.arrayValue!.values || []).map(v =>  FieldValue.of(v));
  }

  toString(): string {
    return canonicalId(this.proto);
  }
}
