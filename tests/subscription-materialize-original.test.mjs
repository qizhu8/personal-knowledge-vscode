import assert from "node:assert/strict";
import { forkRootName } from "../dist/domain/subscription-materialize-original-fork.js";
const creativeRoot = forkRootName("CreativeGen", "alice", "host-a");
assert.match(creativeRoot, /^_folk_CreativeGen - alice - host-a--[a-f0-9]{12}$/);
assert.strictEqual(forkRootName("CreativeGen", "alice", "host-a"), creativeRoot, "folk identity must be stable");
assert.notStrictEqual(forkRootName("CreativeGen", "bob", "host-b"), creativeRoot, "same-name Brokers from different publishers must not collide");

