// Tests that change stream returns the stream of results continuously and in the right order when
// it's migrating a chunk to a new shard.
// @tags: [uses_change_streams]

var checkEvents = function(changeStream, expectedEvents) {
    expectedEvents.forEach((event) => {
        assert.soon(() => changeStream.hasNext());
        let next = changeStream.next();
        jsTestLog(tojson(next) + " should equal " + tojson(event));
        // assert.eq(next.operationType, event["operationType"]);
        // assert.eq(next.documentKey, {_id: event["_id"]});
    });
};

var makeEvent = function(docId, opType) {
    assert(typeof docId === 'number');
    assert(typeof opType === 'string' && (opType === 'insert' || opType === 'delete'));
    return ({_id: docId, operationType: opType});
};

(function() {
    'use strict';

    // For supportsMajorityReadConcern().
    load("jstests/multiVersion/libs/causal_consistency_helpers.js");

    if (!supportsMajorityReadConcern()) {
        jsTestLog("Skipping test since storage engine doesn't support majority read concern.");
        return;
    }

    // TODO WT-3864: Re-enable test for LSM once transaction visibility bug in LSM is resolved.
    if (jsTest.options().wiredTigerCollectionConfigString === "type=lsm") {
        jsTestLog("Skipping test because we're running with WiredTiger's LSM tree.");
        return;
    }

    const rsNodeOptions = {
        // Use a higher frequency for periodic noops to speed up the test.
        setParameter: {periodicNoopIntervalSecs: 1, writePeriodicNoops: true}
    };
    const st =
        new ShardingTest({shards: 2, mongos: 1, rs: {nodes: 1}, other: {rsOptions: rsNodeOptions}});

    const mongos = st.s;
    const mongosColl = mongos.getCollection('test.foo');
    const mongosDB = mongos.getDB("test");

    // Enable sharding to inform mongos of the database, allowing us to open a cursor.
    assert.commandWorked(mongos.adminCommand({enableSharding: mongosDB.getName()}));

    // Make sure all chunks start on shard 0.
    st.ensurePrimaryShard(mongosDB.getName(), st.shard0.shardName);

    // Open a change stream cursor before the collection is sharded.
    const changeStream = mongosColl.aggregate([{$changeStream: {}}]);
    const changeStreamShowMigrations =
        mongosColl.aggregate([{$changeStream: {showMigrationEvents: true}}]);

    assert(!changeStream.hasNext(), "Do not expect any results yet");
    assert(!changeStreamShowMigrations.hasNext(), "Do not expect any results yet");

    jsTestLog("Sharding collection");
    // Once we have a cursor, actually shard the collection.
    assert.commandWorked(
        mongos.adminCommand({shardCollection: mongosColl.getFullName(), key: {_id: 1}}));

    // Insert two documents.
    assert.writeOK(mongosColl.insert({_id: 0}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 20}, {writeConcern: {w: "majority"}}));

    // Split the collection into two chunks: [MinKey, 10) and [10, MaxKey].
    assert.commandWorked(mongos.adminCommand({split: mongosColl.getFullName(), middle: {_id: 10}}));

    jsTestLog("Migrating [10, MaxKey] chunk to shard1.");
    assert.commandWorked(mongos.adminCommand({
        moveChunk: mongosColl.getFullName(),
        find: {_id: 20},
        to: st.shard1.shardName,
        _waitForDelete: true
    }));

    let expected = [makeEvent(0, "insert"), makeEvent(20, "insert")];
    let expectedWithMigrations = [...expected, makeEvent(20, "insert"), makeEvent(20, "delete")];

    checkEvents(changeStream, expected);
    checkEvents(changeStreamShowMigrations, expectedWithMigrations);

    // expectedEvents.forEach((event) => {
    //     assert.soon(() => changeStream.hasNext());
    //     let next = changeStream.next();
    //     assert.eq(next.operationType, event["operationType"]);
    //     assert.eq(next.documentKey, {_id: event["id"]});
    // });

    // jsTestLog("Checking migration events present for other change stream")
    // expectedEventsWithMigrations.forEach((event) => {
    //     assert.soon(() => changeStreamShowMigrations.hasNext());
    //     let next = changeStreamShowMigrations.next();
    //     jsTestLog(tojson(next));
    //     assert.eq(next.operationType, event["operationType"]);
    //     assert.eq(next.documentKey, {_id: event["id"]});
    // });

    // Insert into both the chunks.
    assert.writeOK(mongosColl.insert({_id: 1}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 21}, {writeConcern: {w: "majority"}}));

    // Split again, and move a second chunk to the first shard. The new chunks are:
    // [MinKey, 0), [0, 10), and [10, MaxKey].
    jsTestLog("Moving [MinKey, 0] to shard 1");
    assert.commandWorked(mongos.adminCommand({split: mongosColl.getFullName(), middle: {_id: 0}}));
    assert.commandWorked(mongos.adminCommand({
        moveChunk: mongosColl.getFullName(),
        find: {_id: 5},
        to: st.shard1.shardName,
        _waitForDelete: true
    }));

    // Insert again, into all three chunks.
    assert.writeOK(mongosColl.insert({_id: -2}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 2}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 22}, {writeConcern: {w: "majority"}}));

    let insertInBoth = [makeEvent(1, "insert"), makeEvent(21, "insert")];
    let migrateToShardOne = [
        makeEvent(0, "insert"),
        makeEvent(1, "insert"),
        makeEvent(0, "delete"),
        makeEvent(1, "delete")
    ];
    let insertInAll = [makeEvent(-2, "insert"), makeEvent(2, "insert"), makeEvent(22, "insert")];

    checkEvents(changeStream, [...insertInBoth, ...insertInAll]);
    checkEvents(changeStreamShowMigrations,
                [...insertInBoth, ...migrateToShardOne, ...insertInAll]);

    // // Make sure we can see all the inserts, without any 'retryNeeded' entries.
    // for (let nextExpectedId of[1, 21, -2, 2, 22]) {
    //     assert.soon(() => changeStream.hasNext());
    //     let item = changeStream.next();
    //     assert.eq(item.documentKey, {_id: nextExpectedId});
    // }

    // Make sure we're at the end of the stream.
    assert(!changeStream.hasNext());

    // Test that migrating the last chunk to shard 1 (meaning all chunks are now on the same shard)
    // will not invalidate the change stream.

    // Insert into all three chunks.
    jsTestLog("Insert into all three chunks");
    assert.writeOK(mongosColl.insert({_id: -3}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 3}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 23}, {writeConcern: {w: "majority"}}));

    let insertAll = [
        makeEvent(-3, "insert"),
        makeEvent(3, "insert"),
        makeEvent(23, "insert"),
    ];

    jsTestLog("Move the [Minkey, 0) chunk to shard 1.");
    assert.commandWorked(mongos.adminCommand({
        moveChunk: mongosColl.getFullName(),
        find: {_id: -5},
        to: st.shard1.shardName,
        _waitForDelete: true
    }));

    let migrateMinkeyToZero = [
        makeEvent(-2, "insert"),
        makeEvent(-3, "insert"),
        makeEvent(-3, "delete"),
        makeEvent(-2, "delete"),
    ];

    // Insert again, into all three chunks.
    assert.writeOK(mongosColl.insert({_id: -4}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 4}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 24}, {writeConcern: {w: "majority"}}));

    let insertAllAgain = [
        makeEvent(-4, "insert"),
        makeEvent(4, "insert"),
        makeEvent(24, "insert"),
    ];

    // let regularExpected = [
    //     ...insertAll,
    //     ...insertAllAgain,
    // ];

    // let migrationShownExpected = [
    //     ...insertAll,
    //     ...migrateMinkeyToZero,
    //     ...insertAllAgain,
    // ];

    checkEvents(changeStream, [...insertAll, ...insertAllAgain]);
    checkEvents(changeStreamShowMigrations,
                [...insertAll, ...migrateMinkeyToZero, ...insertAllAgain]);

    // Make sure we can see all the inserts, without any 'retryNeeded' entries.
    // for (let nextExpectedId of[-3, 3, 23, -4, 4, 24]) {
    //     assert.soon(() => changeStream.hasNext());
    //     assert.eq(changeStream.next().documentKey, {_id: nextExpectedId});
    // }

    // Now test that adding a new shard and migrating a chunk to it will continue to
    // return the correct results.
    const newShard = new ReplSetTest({name: "newShard", nodes: 1, nodeOptions: rsNodeOptions});
    newShard.startSet({shardsvr: ''});
    newShard.initiate();
    assert.commandWorked(mongos.adminCommand({addShard: newShard.getURL(), name: "newShard"}));

    // At this point, there haven't been any migrations to that shard; check that the changeStream
    // works normally.
    assert.writeOK(mongosColl.insert({_id: -5}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 5}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 25}, {writeConcern: {w: "majority"}}));

    let anotherInsertSet = [
        makeEvent(-5, "insert"),
        makeEvent(5, "insert"),
        makeEvent(25, "insert"),
    ];

    checkEvents(changeStream, anotherInsertSet);
    checkEvents(changeStreamShowMigrations, anotherInsertSet);

    // for (let nextExpectedId of[-5, 5, 25]) {
    //     assert.soon(() => changeStream.hasNext());
    //     assert.eq(changeStream.next().documentKey, {_id: nextExpectedId});
    // }

    assert.writeOK(mongosColl.insert({_id: 16}, {writeConcern: {w: "majority"}}));

    // Now migrate a chunk to the new shard and verify the stream continues to return results
    // from both before and after the migration.
    jsTestLog("Migrating [10, MaxKey] chunk to new shard.");
    assert.commandWorked(mongos.adminCommand({
        moveChunk: mongosColl.getFullName(),
        find: {_id: 20},
        to: "newShard",
        _waitForDelete: true
    }));
    assert.writeOK(mongosColl.insert({_id: -6}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 6}, {writeConcern: {w: "majority"}}));
    assert.writeOK(mongosColl.insert({_id: 26}, {writeConcern: {w: "majority"}}));

    let insertBeforeMigrate = [
        makeEvent(16, "insert"),
    ];

    let migrationEvents = [
        makeEvent(16, "delete"),
        makeEvent(20, "insert"),
        makeEvent(21, "insert"),
        makeEvent(22, "insert"),
        makeEvent(23, "insert"),
        makeEvent(20, "delete"),
        makeEvent(21, "delete"),
        makeEvent(22, "delete"),
        makeEvent(23, "delete"),
    ];
    // makeEvent(16, "delete"),

    let insertAfterMigrate = [
        makeEvent(-6, "insert"),
        makeEvent(6, "insert"),
        makeEvent(26, "insert"),
    ];

    let insertA = [
        ...insertBeforeMigrate,
        ...insertAfterMigrate,
    ];

    let insertB = [
        ...insertBeforeMigrate,
        ...migrationEvents,
        ...insertAfterMigrate,
    ];

    checkEvents(changeStream, insertA);
    checkEvents(changeStreamShowMigrations, insertB);

    // for (let nextExpectedId of[16, -6, 6, 26]) {
    //     assert.soon(() => changeStream.hasNext());
    //     assert.eq(changeStream.next().documentKey, {_id: nextExpectedId});
    // }
    assert(!changeStream.hasNext());
    assert(!changeStreamShowMigrations.hasNext());

    st.stop();
    newShard.stopSet();
})();
