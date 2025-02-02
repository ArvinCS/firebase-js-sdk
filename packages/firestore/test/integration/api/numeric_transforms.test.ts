/**
 * @license
 * Copyright 2018 Google LLC
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

import { expect } from 'chai';

import { EventsAccumulator } from '../util/events_accumulator';
import {
  deleteField,
  disableNetwork,
  DocumentData,
  DocumentSnapshot,
  enableNetwork,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  DocumentReference,
  increment,
  Firestore
} from '../util/firebase_export';
import { apiDescribe, withTestDoc } from '../util/helpers';

const DOUBLE_EPSILON = 0.000001;

apiDescribe('Numeric Transforms:', persistence => {
  // A document reference to read and write to.
  let docRef: DocumentReference;

  let db: Firestore;

  // Accumulator used to capture events during the test.
  let accumulator: EventsAccumulator<DocumentSnapshot>;

  // Listener registration for a listener maintained during the course of the
  // test.
  let unsubscribe: () => void;

  /** Writes some initialData and consumes the events generated. */
  async function writeInitialData(initialData: DocumentData): Promise<void> {
    await setDoc(docRef, initialData);
    await accumulator.awaitLocalEvent();
    const snapshot = await accumulator.awaitRemoteEvent();
    expect(snapshot.data()).to.deep.equal(initialData);
  }

  async function expectLocalAndRemoteValue(expectedSum: number): Promise<void> {
    const localSnap = await accumulator.awaitLocalEvent();
    expect(localSnap.get('sum')).to.be.closeTo(expectedSum, DOUBLE_EPSILON);
    const remoteSnap = await accumulator.awaitRemoteEvent();
    expect(remoteSnap.get('sum')).to.be.closeTo(expectedSum, DOUBLE_EPSILON);
  }

  /**
   * Wraps a test, getting a docRef and event accumulator, and cleaning them
   * up when done.
   */
  async function withTestSetup<T>(test: () => Promise<T>): Promise<void> {
    await withTestDoc(persistence, async (doc, firestore) => {
      docRef = doc;
      db = firestore;
      accumulator = new EventsAccumulator<DocumentSnapshot>();
      unsubscribe = onSnapshot(
        docRef,
        { includeMetadataChanges: true },
        accumulator.storeEvent
      );

      // wait for initial null snapshot to avoid potential races.
      const snapshot = await accumulator.awaitRemoteEvent();
      expect(snapshot.exists()).to.be.false;
      await test();
      unsubscribe();
    });
  }

  it('create document with increment', async () => {
    await withTestSetup(async () => {
      await setDoc(docRef, { sum: increment(1337) });
      await expectLocalAndRemoteValue(1337);
    });
  });

  it('merge on non-existing document with increment', async () => {
    await withTestSetup(async () => {
      await setDoc(docRef, { sum: increment(1337) }, { merge: true });
      await expectLocalAndRemoteValue(1337);
    });
  });

  it('increment existing integer with integer', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 1337 });
      await updateDoc(docRef, 'sum', increment(1));
      await expectLocalAndRemoteValue(1338);
    });
  });

  it('increment existing double with double', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 13.37 });
      await updateDoc(docRef, 'sum', increment(0.1));
      await expectLocalAndRemoteValue(13.47);
    });
  });

  it('increment existing double with integer', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 13.37 });
      await updateDoc(docRef, 'sum', increment(1));
      await expectLocalAndRemoteValue(14.37);
    });
  });

  it('increment existing integer with double', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 1337 });
      await updateDoc(docRef, 'sum', increment(0.1));
      await expectLocalAndRemoteValue(1337.1);
    });
  });

  it('increment existing string with integer', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 'overwrite' });
      await updateDoc(docRef, 'sum', increment(1337));
      await expectLocalAndRemoteValue(1337);
    });
  });

  it('increment existing string with double', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 'overwrite' });
      await updateDoc(docRef, 'sum', increment(13.37));
      await expectLocalAndRemoteValue(13.37);
    });
  });

  it('increments with set() and merge:true', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 1 });
      await setDoc(docRef, { sum: increment(1337) }, { merge: true });
      await expectLocalAndRemoteValue(1338);
    });
  });

  it('multiple double increments', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 0.0 });

      await disableNetwork(db);

      /* eslint-disable @typescript-eslint/no-floating-promises */
      updateDoc(docRef, 'sum', increment(0.1));
      updateDoc(docRef, 'sum', increment(0.01));
      updateDoc(docRef, 'sum', increment(0.001));
      /* eslint-enable @typescript-eslint/no-floating-promises */

      let snap = await accumulator.awaitLocalEvent();
      expect(snap.get('sum')).to.be.closeTo(0.1, DOUBLE_EPSILON);
      snap = await accumulator.awaitLocalEvent();
      expect(snap.get('sum')).to.be.closeTo(0.11, DOUBLE_EPSILON);
      snap = await accumulator.awaitLocalEvent();
      expect(snap.get('sum')).to.be.closeTo(0.111, DOUBLE_EPSILON);

      await enableNetwork(db);

      snap = await accumulator.awaitRemoteEvent();
      expect(snap.get('sum')).to.be.closeTo(0.111, DOUBLE_EPSILON);
    });
  });

  it('increment twice in a batch', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 'overwrite' });

      const batch = writeBatch(db);
      batch.update(docRef, 'sum', increment(1));
      batch.update(docRef, 'sum', increment(1));
      await batch.commit();

      await expectLocalAndRemoteValue(2);
    });
  });

  it('increment, delete and increment in a batch', async () => {
    await withTestSetup(async () => {
      await writeInitialData({ sum: 'overwrite' });

      const batch = writeBatch(db);
      batch.update(docRef, 'sum', increment(1));
      batch.update(docRef, 'sum', deleteField());
      batch.update(docRef, 'sum', increment(3));
      await batch.commit();

      await expectLocalAndRemoteValue(3);
    });
  });

  it('increment on top of ServerTimestamp', async () => {
    // This test stacks two pending transforms (a ServerTimestamp and an Increment transform)
    // and reproduces the setup that was reported in
    // https://github.com/firebase/firebase-android-sdk/issues/491
    // In our original code, a NumericIncrementTransformOperation could cause us to decode the
    // ServerTimestamp as part of a PatchMutation, which triggered an assertion failure.
    await withTestSetup(async () => {
      await disableNetwork(db);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      setDoc(docRef, { val: serverTimestamp() });
      let snap = await accumulator.awaitLocalEvent();
      expect(snap.get('val', { serverTimestamps: 'estimate' })).to.not.be.null;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      setDoc(docRef, { val: increment(1) });
      snap = await accumulator.awaitLocalEvent();
      expect(snap.get('val')).to.equal(1);

      await enableNetwork(db);

      snap = await accumulator.awaitRemoteEvent();
      expect(snap.get('val')).to.equal(1);
    });
  });
});
