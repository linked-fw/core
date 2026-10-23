import {beforeEach, describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {LinkedStorage} from '../utils/LinkedStorage';
import type {IDataset} from '../interfaces/IDataset';
import type {NodeReferenceValue} from '../utils/NodeReference';
import {unusedDatasetMethods} from '../test-helpers/test-utils';

const {linkedShape} = linkedPackage('store-routing-test');

const type = (suffix: string): NodeReferenceValue => ({
  id: `linked://tmp/types/${suffix}`,
});

@linkedShape
class RoutedPerson extends Shape {
  static targetClass = type('RoutedPerson');
}

@linkedShape
class RoutedEmployee extends RoutedPerson {
  static targetClass = type('RoutedEmployee');
}

@linkedShape
class RoutedPet extends Shape {
  static targetClass = type('RoutedPet');
}

type StoreCalls = {
  select: number;
  ask: number;
  update: number;
  create: number;
  delete: number;
};

const createStore = () => {
  const calls: StoreCalls = {select: 0, ask: 0, update: 0, create: 0, delete: 0};
  const store: IDataset = {
    ...unusedDatasetMethods,
    selectQuery: async () => {
      calls.select += 1;
      return [];
    },
    askQuery: async () => {
      calls.ask += 1;
      return false;
    },
    updateQuery: async () => {
      calls.update += 1;
      return {id: 'mock'};
    },
    createQuery: async () => {
      calls.create += 1;
      return {id: 'mock'};
    },
    deleteQuery: async () => {
      calls.delete += 1;
      return {deleted: [], count: 0};
    },
  };
  return {store, calls};
};

describe('LinkedStorage store routing', () => {
  test('routes select queries based on shape mapping', async () => {
    const defaultStore = createStore();
    const personStore = createStore();
    LinkedStorage.setDefaultDataset(defaultStore.store);
    LinkedStorage.setDatasetForShapes(personStore.store, RoutedPerson);

    await LinkedStorage.selectQuery(RoutedPerson.select() as any);

    expect(personStore.calls.select).toBe(1);
    expect(defaultStore.calls.select).toBe(0);
  });

  test('routes select queries to default store when no mapping exists', async () => {
    const defaultStore = createStore();
    LinkedStorage.setDefaultDataset(defaultStore.store);

    await LinkedStorage.selectQuery(RoutedPet.select() as any);

    expect(defaultStore.calls.select).toBe(1);
  });

  test('uses parent shape store for subclasses', async () => {
    const defaultStore = createStore();
    const personStore = createStore();
    LinkedStorage.setDefaultDataset(defaultStore.store);
    LinkedStorage.setDatasetForShapes(personStore.store, RoutedPerson);

    await LinkedStorage.selectQuery(RoutedEmployee.select() as any);

    expect(personStore.calls.select).toBe(1);
    expect(defaultStore.calls.select).toBe(0);
  });

  test('routes update/create/delete using node shape ids', async () => {
    const defaultStore = createStore();
    const personStore = createStore();
    LinkedStorage.setDefaultDataset(defaultStore.store);
    LinkedStorage.setDatasetForShapes(personStore.store, RoutedPerson);

    await LinkedStorage.updateQuery(RoutedPerson.update({}).for('p1') as any);
    await LinkedStorage.createQuery(RoutedPerson.create({}) as any);
    await LinkedStorage.deleteQuery(RoutedPerson.delete('p1') as any);

    expect(personStore.calls.update).toBe(1);
    expect(personStore.calls.create).toBe(1);
    expect(personStore.calls.delete).toBe(1);
    expect(defaultStore.calls.update).toBe(0);
  });
});

// =============================================================================
// Existence checks route like everything else — and degrade in one place
// =============================================================================

describe('LinkedStorage.askQuery routing', () => {
  // Shape pins are static and accumulate across tests. Fan-out asks *every*
  // known dataset and short-circuits on the first `true`, so a pin left by an
  // earlier test would make these order-dependent.
  beforeEach(() => {
    LinkedStorage.getShapeToDatasetMap().clear();
  });

  /** A store that can answer a boolean directly. */
  const createAskStore = (answer: boolean) => {
    const calls = {ask: 0, select: 0};
    const store: IDataset = {
      ...unusedDatasetMethods,
      selectQuery: async () => {
        calls.select += 1;
        return [] as any;
      },
      askQuery: async () => {
        calls.ask += 1;
        return answer;
      },
    };
    return {store, calls};
  };

  test('routes to the shape-pinned dataset, not the default', async () => {
    const defaultStore = createAskStore(false);
    const personStore = createAskStore(true);
    LinkedStorage.setDefaultDataset(defaultStore.store);
    LinkedStorage.setDatasetForShapes(personStore.store, RoutedPerson);

    await expect(
      LinkedStorage.askQuery(RoutedPerson.select() as any),
    ).resolves.toBe(true);
    expect(personStore.calls.ask).toBe(1);
    expect(defaultStore.calls.ask).toBe(0);
  });

  test('the routed dataset is asked, and its selectQuery is never touched', async () => {
    const store = createStore();
    LinkedStorage.setDefaultDataset(store.store);
    LinkedStorage.setDatasetForShapes(store.store, RoutedPet);

    await expect(
      LinkedStorage.askQuery(RoutedPet.select() as any),
    ).resolves.toBe(false);
    expect(store.calls.ask).toBe(1);
    expect(store.calls.select).toBe(0);
  });

  test('a store failure propagates — it is never routed into a false', async () => {
    const broken: IDataset = {
      ...unusedDatasetMethods,
      selectQuery: async () => {
        throw new Error('store unreachable');
      },
      askQuery: async () => {
        throw new Error('store unreachable');
      },
    };
    LinkedStorage.setDefaultDataset(broken);
    LinkedStorage.setDatasetForShapes(broken, RoutedPet);

    await expect(
      LinkedStorage.askQuery(RoutedPet.select() as any),
    ).rejects.toThrow(/store unreachable/);
  });

  test('a SHAPELESS ask fans out across every dataset and ORs the answers', async () => {
    // No shape means no routing key. Asking only the default store would answer
    // false for a node living in a pinned one — a wrong answer, quietly.
    const defaultStore = createAskStore(false);
    const pinned = createAskStore(true);
    LinkedStorage.setDefaultDataset(defaultStore.store);
    LinkedStorage.setDatasetForShapes(pinned.store, RoutedPerson);

    await expect(LinkedStorage.askQuery({} as any)).resolves.toBe(true);
    expect(defaultStore.calls.ask + pinned.calls.ask).toBeGreaterThan(0);
  });

  test('a shapeless ask is false only when every dataset says so', async () => {
    const a = createAskStore(false);
    const b = createAskStore(false);
    LinkedStorage.setDefaultDataset(a.store);
    LinkedStorage.setDatasetForShapes(b.store, RoutedPerson);

    await expect(LinkedStorage.askQuery({} as any)).resolves.toBe(false);
    expect(a.calls.ask).toBe(1);
    expect(b.calls.ask).toBe(1);
  });

  test('a failure during fan-out propagates — unknown is not false', async () => {
    const broken: IDataset = {
      ...unusedDatasetMethods,
      selectQuery: async () => [],
      askQuery: async () => {
        throw new Error('one store unreachable');
      },
    };
    LinkedStorage.setDefaultDataset(broken);
    await expect(LinkedStorage.askQuery({} as any)).rejects.toThrow(
      /one store unreachable/,
    );
  });
});
