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

import * as api from '../../../src/protos/firestore_proto_api';

import { expect } from 'chai';
import { GeoPoint } from '../../../src/api/geo_point';
import { ObjectValue, TypeOrder } from '../../../src/model/field_value';
import { typeOrder } from '../../../src/model/values';
import * as typeUtils from '../../../src/util/types';
import { blob, field, mask, wrap, wrapObject } from '../../util/helpers';

describe('FieldValue', () => {
  const date1 = new Date(2016, 4, 2, 1, 5);
  const date2 = new Date(2016, 5, 20, 10, 20, 30);

  it('can parse integers', () => {
    const primitiveValues = [
      typeUtils.MIN_SAFE_INTEGER,
      -1,
      0,
      1,
      2,
      typeUtils.MAX_SAFE_INTEGER
    ];
    const values = primitiveValues.map(v => wrap(v));

    values.forEach(v => {
      expect(typeOrder(v)).to.equal(TypeOrder.NumberValue);
    });

    for (let i = 0; i < primitiveValues.length; i++) {
      const primitiveValue = primitiveValues[i];
      const value = values[i];
      expect(value).to.deep.equal({ integerValue: primitiveValue });
    }
  });

  it('can parse doubles', () => {
    const primitiveValues = [
      typeUtils.MIN_SAFE_INTEGER - 1,
      -1.1,
      0.1,
      typeUtils.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
      -Infinity
    ];
    const values = primitiveValues.map(v => wrap(v));

    values.forEach(v => {
      expect(typeOrder(v)).to.equal(TypeOrder.NumberValue);
    });

    for (let i = 0; i < primitiveValues.length; i++) {
      const primitiveValue = primitiveValues[i];
      const value = values[i];
      if (isNaN(primitiveValue)) {
        expect(value).to.deep.equal({ doubleValue: 'NaN' });
      } else if (primitiveValue == Infinity) {
        expect(value).to.deep.equal({ doubleValue: 'Infinity' });
      } else if (primitiveValue == -Infinity) {
        expect(value).to.deep.equal({ doubleValue: '-Infinity' });
      } else {
        expect(value).to.deep.equal({ doubleValue: primitiveValue });
      }
    }
  });

  it('can parse null', () => {
    const nullValue = wrap(null);

    expect(typeOrder(nullValue)).to.equal(TypeOrder.NullValue);
    expect(nullValue).to.deep.equal({ nullValue: 'NULL_VALUE' });
  });

  it('can parse booleans', () => {
    const trueValue = wrap(true);
    const falseValue = wrap(false);

    expect(typeOrder(trueValue)).to.equal(TypeOrder.BooleanValue);
    expect(typeOrder(falseValue)).to.equal(TypeOrder.BooleanValue);

    expect(trueValue).to.deep.equal({ booleanValue: true });
    expect(falseValue).to.deep.equal({ booleanValue: false });
  });

  it('can parse dates', () => {
    const dateValue1 = wrap(date1);
    const dateValue2 = wrap(date2);

    expect(typeOrder(dateValue1)).to.equal(TypeOrder.TimestampValue);
    expect(typeOrder(dateValue2)).to.equal(TypeOrder.TimestampValue);

    expect(dateValue1).to.deep.equal({
      timestampValue: { seconds: 1462176300, nanos: 0 }
    });
    expect(dateValue2).to.deep.equal({
      timestampValue: { seconds: 1466443230, nanos: 0 }
    });
  });

  it('can parse geo points', () => {
    const latLong1 = new GeoPoint(1.23, 4.56);
    const latLong2 = new GeoPoint(-20, 100);
    const value1 = wrap(latLong1);
    const value2 = wrap(latLong2);

    expect(typeOrder(value1)).to.equal(TypeOrder.GeoPointValue);
    expect(typeOrder(value2)).to.equal(TypeOrder.GeoPointValue);

    expect(value1).to.deep.equal({
      geoPointValue: { latitude: 1.23, longitude: 4.56 }
    });
    expect(value2).to.deep.equal({
      geoPointValue: { latitude: -20, longitude: 100 }
    });
  });

  it('can parse bytes', () => {
    const bytesValue = wrap(blob(0, 1, 2));

    expect(typeOrder(bytesValue)).to.equal(TypeOrder.BlobValue);
    expect(bytesValue).to.deep.equal({ bytesValue: 'AAEC' });
  });

  it('can parse simple objects', () => {
    const objValue = wrap({ a: 'foo', b: 1, c: true, d: null });

    expect(typeOrder(objValue)).to.equal(TypeOrder.ObjectValue);
    expect(objValue).to.deep.equal({
      'mapValue': {
        'fields': {
          'a': {
            'stringValue': 'foo'
          },
          'b': {
            'integerValue': 1
          },
          'c': {
            'booleanValue': true
          },
          'd': {
            'nullValue': 'NULL_VALUE'
          }
        }
      }
    });
  });

  it('can parse nested objects', () => {
    const objValue = wrap({ foo: { bar: 1, baz: [1, 2, { a: 'b' }] } });

    expect(typeOrder(objValue)).to.equal(TypeOrder.ObjectValue);
    expect(objValue).to.deep.equal({
      'mapValue': {
        'fields': {
          'foo': {
            'mapValue': {
              'fields': {
                'bar': {
                  'integerValue': 1
                },
                'baz': {
                  'arrayValue': {
                    'values': [
                      {
                        'integerValue': 1
                      },
                      {
                        'integerValue': 2
                      },
                      {
                        'mapValue': {
                          'fields': {
                            'a': {
                              'stringValue': 'b'
                            }
                          }
                        }
                      }
                    ]
                  }
                }
              }
            }
          }
        }
      }
    });
  });

  it('can parse empty objects', () => {
    const objValue = wrap({ foo: {} });

    expect(typeOrder(objValue)).to.equal(TypeOrder.ObjectValue);
    expect(objValue).to.deep.equal({
      'mapValue': {
        'fields': {
          'foo': {
            'mapValue': {}
          }
        }
      }
    });
  });

  it('can extract fields', () => {
    const objValue = wrapObject({ foo: { a: 1, b: true, c: 'string' } });

    expect(typeOrder(objValue.field(field('foo'))!)).to.equal(
      TypeOrder.ObjectValue
    );
    expect(typeOrder(objValue.field(field('foo.a'))!)).to.equal(
      TypeOrder.NumberValue
    );
    expect(typeOrder(objValue.field(field('foo.b'))!)).to.equal(
      TypeOrder.BooleanValue
    );
    expect(typeOrder(objValue.field(field('foo.c'))!)).to.equal(
      TypeOrder.StringValue
    );

    expect(objValue.field(field('foo.a.b'))).to.be.null;
    expect(objValue.field(field('bar'))).to.be.null;
    expect(objValue.field(field('bar.a'))).to.be.null;

    expect(objValue.field(field('foo'))!).to.deep.equal(
      wrap({
        a: 1,
        b: true,
        c: 'string'
      })
    );
    expect(objValue.field(field('foo.a'))).to.deep.equal(wrap(1));
    expect(objValue.field(field('foo.b'))).to.deep.equal(wrap(true));
    expect(objValue.field(field('foo.c'))).to.deep.equal(wrap('string'));
  });

  it('can overwrite existing fields', () => {
    const objValue = wrapObject({ foo: 'foo-value' });

    const objValue2 = setField(objValue, 'foo', wrap('new-foo-value'));
    assertObjectEquals(objValue, {
      foo: 'foo-value'
    }); // unmodified original
    assertObjectEquals(objValue2, { foo: 'new-foo-value' });
  });

  it('can add new fields', () => {
    const objValue = wrapObject({ foo: 'foo-value' });

    const objValue2 = setField(objValue, 'bar', wrap('bar-value'));
    assertObjectEquals(objValue, {
      foo: 'foo-value'
    }); // unmodified original
    assertObjectEquals(objValue2, {
      foo: 'foo-value',
      bar: 'bar-value'
    });
  });

  it('can add multiple new fields', () => {
    let objValue = ObjectValue.EMPTY;
    objValue = objValue
      .toBuilder()
      .set(field('a'), wrap('a'))
      .build();
    objValue = objValue
      .toBuilder()
      .set(field('b'), wrap('b'))
      .set(field('c'), wrap('c'))
      .build();

    assertObjectEquals(objValue, { a: 'a', b: 'b', c: 'c' });
  });

  it('can implicitly create objects', () => {
    const objValue = wrapObject({ foo: 'foo-value' });

    const objValue2 = setField(objValue, 'a.b', wrap('b-value'));
    assertObjectEquals(objValue, {
      foo: 'foo-value'
    }); // unmodified original
    assertObjectEquals(objValue2, {
      foo: 'foo-value',
      a: { b: 'b-value' }
    });
  });

  it('can overwrite primitive values to create objects', () => {
    const objValue = wrapObject({ foo: 'foo-value' });

    const objValue2 = setField(objValue, 'foo.bar', wrap('bar-value'));
    assertObjectEquals(objValue, {
      foo: 'foo-value'
    }); // unmodified original
    assertObjectEquals(objValue2, { foo: { bar: 'bar-value' } });
  });

  it('can add to nested objects', () => {
    const objValue = wrapObject({ foo: { bar: 'bar-value' } });

    const objValue2 = setField(objValue, 'foo.baz', wrap('baz-value'));
    assertObjectEquals(objValue, {
      foo: { bar: 'bar-value' }
    }); // unmodified original
    assertObjectEquals(objValue2, {
      foo: { bar: 'bar-value', baz: 'baz-value' }
    });
  });

  it('can delete keys', () => {
    const objValue = wrapObject({ foo: 'foo-value', bar: 'bar-value' });

    const objValue2 = deleteField(objValue, 'foo');
    assertObjectEquals(objValue, {
      foo: 'foo-value',
      bar: 'bar-value'
    }); // unmodified original
    assertObjectEquals(objValue2, { bar: 'bar-value' });
  });

  it('can delete nested keys', () => {
    const objValue = wrapObject({
      foo: { bar: 'bar-value', baz: 'baz-value' }
    });

    const objValue2 = deleteField(objValue, 'foo.bar');
    assertObjectEquals(objValue, {
      foo: { bar: 'bar-value', baz: 'baz-value' }
    }); // unmodified original
    assertObjectEquals(objValue2, { foo: { baz: 'baz-value' } });
  });

  it('can delete added keys', () => {
    let objValue = wrapObject({});

    objValue = objValue
      .toBuilder()
      .set(field('a'), wrap('a'))
      .delete(field('a'))
      .build();

    assertObjectEquals(objValue, {});
  });

  it('can delete, resulting in empty object', () => {
    const objValue = wrapObject({ foo: { bar: 'bar-value' } });

    const objValue2 = deleteField(objValue, 'foo.bar');
    assertObjectEquals(objValue, {
      foo: { bar: 'bar-value' }
    }); // unmodified original
    assertObjectEquals(objValue2, { foo: {} });
  });

  it('will not delete nested keys on primitive values', () => {
    const objValue = wrapObject({ foo: { bar: 'bar-value' }, a: 1 });

    const expected = { foo: { bar: 'bar-value' }, a: 1 };
    const objValue2 = deleteField(objValue, 'foo.baz');
    const objValue3 = deleteField(objValue, 'foo.bar.baz');
    const objValue4 = deleteField(objValue, 'a.b');
    assertObjectEquals(objValue, expected);
    assertObjectEquals(objValue2, expected);
    assertObjectEquals(objValue3, expected);
    assertObjectEquals(objValue4, expected);
  });

  it('can delete multiple fields', () => {
    let objValue = wrapObject({ a: 'a', b: 'a', c: 'c' });

    objValue = objValue
      .toBuilder()
      .delete(field('a'))
      .build();
    objValue = objValue
      .toBuilder()
      .delete(field('b'))
      .delete(field('c'))
      .build();

    assertObjectEquals(objValue, {});
  });

  it('provides field mask', () => {
    const objValue = wrapObject({
      a: 'b',
      map: { a: 1, b: true, c: 'string', nested: { d: 'e' } },
      emptymap: {}
    });
    const expectedMask = mask(
      'a',
      'map.a',
      'map.b',
      'map.c',
      'map.nested.d',
      'emptymap'
    );
    const actualMask = objValue.fieldMask();
    expect(actualMask.isEqual(expectedMask)).to.be.true;
  });

  function setField(
    objectValue: ObjectValue,
    fieldPath: string,
    value: api.Value
  ): ObjectValue {
    return objectValue
      .toBuilder()
      .set(field(fieldPath), value)
      .build();
  }

  function deleteField(
    objectValue: ObjectValue,
    fieldPath: string
  ): ObjectValue {
    return objectValue
      .toBuilder()
      .delete(field(fieldPath))
      .build();
  }

  function assertObjectEquals(
    objValue: ObjectValue,
    data: { [k: string]: unknown }
  ) {
    expect(objValue.isEqual(wrapObject(data)));
  }
});
