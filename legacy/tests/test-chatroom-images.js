const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const ts = require("typescript");
const { ChatClient } = require("../dist/chatroom/chatroom-client");
const { ChatHub } = require("../dist/chatroom/chatroom-hub");
const images = require("../dist/chatroom/chatroom-images");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const input = { mime:"image/png", dataBase64:png.toString("base64") };

function managerFixture() {
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ChatRoomManager");
  const scope = { ...images, process, setInterval, clearInterval, setTimeout, clearTimeout, postToPanel() {}, log:{ action() {} } };
  vm.runInNewContext(ts.transpileModule(`${declaration.getText(ast)}\nglobalThis.Manager = ChatRoomManager;`,
    { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText, scope);
  const manager = new scope.Manager();
  manager.push = () => {};
  return manager;
}

test("Clipboard images are bounded, decoded and validated as raster data, not arbitrary supplied MIME", () => {
  assert.deepEqual(images.decodeChatroomImages([input]), [{ name:"pasted-image-1.png", mime:"image/png", data:png }]);
  assert.equal(images.decodeChatroomImages(Array(4).fill(input)).length,4);
  const maximum = Buffer.alloc(images.MAX_CHATROOM_IMAGE_BYTES);
  png.copy(maximum);
  assert.equal(images.decodeChatroomImages([{...input,dataBase64:maximum.toString("base64")}])[0].data.length,images.MAX_CHATROOM_IMAGE_BYTES);
  for (const bad of [null, [], Array(5).fill(input), [{...input,mime:"image/svg+xml"}],
    [{...input,dataBase64:"%%%"}], [{...input,dataBase64:Buffer.from("<svg/>").toString("base64")}],
    [{...input,dataBase64:"YQ==="}], [{...input,dataBase64:Buffer.alloc(images.MAX_CHATROOM_IMAGE_BYTES + 1).toString("base64")}]]) {
    assert.throws(() => images.decodeChatroomImages(bad));
  }
});

test("Image sends bind to the intended Room and retain sender preview without repeating bytes in status", async () => {
  const manager = managerFixture(), sent = [];
  const room = { key:"a", user:"Host", files:new Map(), selfMuted:false,
    client:{ isConnected:true, async sendFile(name,mime,data) {
      sent.push({name,mime,data}); return {ok:true,file:{fileId:"f1",name,mime,size:data.length}};
    }, sendText(...args) { sent.push(args); return true; } } };
  manager.rooms.set("a",room); manager.activeKey = "a";
  await assert.rejects(manager.sendImages("wrong",[input],["text"]), /Room changed/);
  room.selfMuted = true;
  await assert.rejects(manager.sendImages("a",[input],["text"]), /muted/);
  room.selfMuted = false;
  await assert.rejects(manager.sendImages("a",[input,{...input,mime:"text/html"}],["text"]), /Paste/);
  assert.equal(sent.length,0,"validate the whole batch before publishing any file");
  await manager.sendImages("a",[input],["look at this"]);
  assert.equal(sent.length,2);
  assert.equal(sent[1][0],"look at this");
  assert.equal(manager.imagePreview("a","f1"), `data:image/png;base64,${input.dataBase64}`);
  assert.throws(() => manager.imagePreview("other","f1"), /no longer available/);
  room.files.set("fake",{meta:{mime:"image/png"},data:Buffer.from("<svg/>")});
  assert.throws(() => manager.imagePreview("a","fake"), /not a supported/);
  room.client.sendFile = async () => ({ok:false,error:"lost connection"});
  await assert.rejects(manager.sendImages("a",[input],["must not send"]), /lost connection/);
  assert.equal(sent.length,2);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve,10));
  }
  throw new Error("Timed out waiting for Chatroom transfer");
}

test("Actual Room clients transfer clipboard image bytes and MIME over the existing file channel", async () => {
  const hub = new ChatHub();
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"pkm-room-images-"));
  const secrets = new Map();
  hub.configureLifecycle(root,1024 * 1024,"owner",{
    get:async key => secrets.get(key), store:async (key,value) => { secrets.set(key,value); },delete:async key => { secrets.delete(key); },
  });
  const received = [], clients = [];
  try {
    await hub.start(0);
    const room = await hub.createRoom("Image paste", "secret");
    for (const [user,host] of [["Host",true],["Peer",false]]) {
      const client = new ChatClient({ onStatus() {},onMessage() {},onHistory() {},onPresence() {},
        onFileComplete(meta,from,data) { received.push({user,meta,from,data}); } });
      clients.push(client);
      client.connect({url:`ws://127.0.0.1:${hub.port}`,room:room.room,roomId:room.roomId,user,token:room.secret,...(host?{hostToken:room.hostToken}:{})});
      await waitFor(() => client.isConnected);
    }
    const result = await clients[0].sendFile("clipboard.png","image/png",png);
    assert.equal(result.ok,true);
    await waitFor(() => received.length === 1);
    assert.equal(received[0].user,"Peer");
    assert.equal(received[0].meta.mime,"image/png");
    assert.equal(received[0].meta.fileId,result.file.fileId);
    assert.deepEqual(received[0].data,png);
    const large = Buffer.concat([png,Buffer.alloc(200*1024)]);
    const chunked = await clients[0].sendFile("larger.png","image/png",large);
    await waitFor(() => received.length === 2);
    assert.equal(received[1].meta.fileId,chunked.file.fileId);
    assert.deepEqual(received[1].data,large,"multiple chunks must reconstruct exact bytes");
    clients[0].disconnect();
    assert.equal((await clients[0].sendFile("clipboard.png","image/png",png)).ok,false);
  } finally { clients.forEach(client => client.disconnect()); await hub.stop(); fs.rmSync(root,{recursive:true,force:true}); }
});

test("File transport errors and a disconnect between chunks are not reported as success", async () => {
  const client = new ChatClient({onStatus(){},onMessage(){},onHistory(){},onPresence(){},onFileComplete(){}});
  client.status = "connected";
  client.opts = {room:"r",user:"Host"};
  const socket = {readyState:1,send(_data,callback){callback(new Error("write failed"));}};
  client.ws = socket;
  await assert.rejects(client.sendFile("image.png","image/png",png),/write failed/);
  let writes = 0;
  socket.send = (_data,callback) => {
    if (++writes === 2) client.ws = null;
    callback();
  };
  await assert.rejects(client.sendFile("image.png","image/png",Buffer.concat([png,Buffer.alloc(200*1024)])),/disconnected/);
  assert.equal(writes,2,"never continue on a different/reconnected socket");
});
