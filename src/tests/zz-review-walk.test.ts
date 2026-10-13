import {test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {deleteToSparql, deleteAllToSparql, updateToSparql} from '../sparql/irToAlgebra';
import {lower} from '../queries/lower';

const {linkedShape} = linkedPackage('zz-review');
const ex = (n: string) => ({id: `http://example.org/z#${n}`});

@linkedShape
class ZA extends Shape {
  static targetClass = ex('ZA');
  @objectProperty({path: ex('toB'), shape: ['zz-review', 'ZB'] as any, contains: true})
  get toB(): any { return null; }
  @objectProperty({path: ex('toB2'), shape: ['zz-review', 'ZB'] as any, contains: true})
  get toB2(): any { return null; }
}
@linkedShape
class ZB extends Shape {
  static targetClass = ex('ZB');
  @objectProperty({path: ex('toA'), shape: ZA, contains: true})
  get toA(): any { return null; }
}
@linkedShape
class ZOwner extends Shape {
  static targetClass = ex('ZOwner');
  @objectProperty({path: ex('a'), shape: ZA, maxCount: 1, contains: true})
  get a(): any { return null; }
  @objectProperty({path: ex('img'), shape: ['zz-review','ZImg'] as any, contains: true})
  get img(): any { return null; }
}
@linkedShape
class ZImg extends Shape {
  static targetClass = ex('ZImg');
  @literalProperty({path: ex('cap'), maxCount: 1})
  get cap(): string { return null; }
}
@linkedShape
class ZPhoto extends ZImg {
  static targetClass = ex('ZPhoto');
  @objectProperty({path: ex('alt'), shape: ZImg, contains: true})
  get alt(): any { return null; }
}

const Z = 'http://example.org/z#';
test('print', () => {
  console.log('DELETE A\n' + deleteToSparql(lower(DeleteBuilder.from(ZA, {id: `${Z}a1`})) as any));
  console.log('DELETE OWNER multi\n' + deleteToSparql(lower(DeleteBuilder.from(ZOwner, [{id: `${Z}o1`}, {id: `${Z}o2`}] as any)) as any));
  console.log('DELETE IMG\n' + deleteToSparql(lower(DeleteBuilder.from(ZImg, {id: `${Z}i1`})) as any));
  console.log('UPDATE owner\n' + updateToSparql(lower(UpdateBuilder.from(ZOwner).for(`${Z}o1`).set({a: {id: `${Z}aa`}, img: {remove: [{id: `${Z}i1`}, {id: `${Z}i2`}]}} as any)) as any));
  console.log('UPDATE A two fields\n' + updateToSparql(lower(UpdateBuilder.from(ZA).for(`${Z}a1`).set({toB: undefined, toB2: [{id: `${Z}b9`}]} as any)) as any));
  console.log('DELETEALL owner\n' + deleteAllToSparql(lower(DeleteBuilder.from(ZOwner).all()) as any));
});
