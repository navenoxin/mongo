(function() {
    'use strict';

    const t = db.jstests_regex;

    const isMaster = db.runCommand("ismaster");
    assert.commandWorked(isMaster);
    const isMongos = (isMaster.msg === "isdbgrid");

    t.drop();
    assert.writeOK(t.save({a: "bcd"}));
    assert.eq(1, t.count({a: /b/}), "A");
    assert.eq(1, t.count({a: /bc/}), "B");
    assert.eq(1, t.count({a: /bcd/}), "C");
    assert.eq(0, t.count({a: /bcde/}), "D");

    t.drop();
    assert.writeOK(t.save({a: {b: "cde"}}));
    assert.eq(1, t.count({'a.b': /de/}), "E");

    t.drop();
    assert.writeOK(t.save({a: {b: ["cde"]}}));
    assert.eq(1, t.count({'a.b': /de/}), "F");

    t.drop();
    assert.writeOK(t.save({a: [{b: "cde"}]}));
    assert.eq(1, t.count({'a.b': /de/}), "G");

    t.drop();
    assert.writeOK(t.save({a: [{b: ["cde"]}]}));
    assert.eq(1, t.count({'a.b': /de/}), "H");

    //
    // Confirm match and explain serialization for $elemMatch with $regex.
    //
    t.drop();
    assert.writeOK(t.insert({x: ["abc"]}));

    const query = {x: {$elemMatch: {$regex: 'ABC', $options: 'i'}}};
    assert.eq(1, t.count(query));

    const result = t.find(query).explain();
    assert.commandWorked(result);

    if (!isMongos) {
        assert(result.hasOwnProperty("queryPlanner"));
        assert(result.queryPlanner.hasOwnProperty("parsedQuery"), tojson(result));
        assert.eq(result.queryPlanner.parsedQuery, query);
    }

    //
    // Disallow embedded null bytes when using $regex syntax.
    //
    t.drop();
    assert.throws(function() {
        t.find({a: {$regex: "a\0b", $options: "i"}}).itcount();
    });
    assert.throws(function() {
        t.find({a: {$regex: "ab", $options: "i\0"}}).itcount();
    });
    assert.throws(function() {
        t.find({key: {$regex: 'abcd\0xyz'}}).explain();
    });

    //
    // Confirm $options and mode specified in $regex are not allowed to be specified together.
    //
    t.drop();
    assert.writeOK(t.insert({x: ["abc"]}));

    assert.throws(function() {
        t.find({x: {$regex: /ab/i, $options: 's'}}).itcount();
    });
    assert.throws(function() {
        t.find({x: {$options: 's', $regex: /ab/i}}).itcount();
    });

    //
    // Confirm $options and $regex options used correctly when other is empty or unspecified
    //
    t.drop();
    assert.writeOK(t.save({x: ["abc"]}));

    assert.eq(1, t.count({x: {$regex: /aBc/i, $options: ''}}), "I");
    assert.eq(1, t.count({x: {$options: '', $regex: /ABC/i}}));

    assert.eq(1, t.count({x: {$regex: /ABC/, $options: 'i'}}));
    assert.eq(1, t.count({x: {$options: 'i', $regex: /ABC/}}));
})();
