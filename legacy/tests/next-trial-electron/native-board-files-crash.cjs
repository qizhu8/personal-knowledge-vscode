"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const startTicks = pid => fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").slice(1).join(") ").split(" ")[19];

exports.create = async ({ fixture, root, target, nonce, host }) => {
  const found = spawnSync("which", ["python3"], { encoding: "utf8" });
  assert.equal(found.status, 0);
  const python = fs.realpathSync(found.stdout.trim());
  const { renameNoReplaceProgram } = await import(pathToFileURL(path.join(target, "next-runtime/server/dist/rename-no-replace.js")).href);
  const configFile = path.join(fixture, "board-file-crash-config.json"), armFile = path.join(fixture, "board-file-crash-arm");
  const directory = path.join(fixture, "board-file-crash-bin");
  fs.mkdirSync(directory, { mode: 0o700 });
  const wrapper = `#!${python}
import hashlib,json,os,pathlib,signal,sqlite3,stat,subprocess,sys
config_file=${JSON.stringify(configFile)}
arm_file=${JSON.stringify(armFile)}
matched=False
try:
    def private_file(name):
        state=os.lstat(name)
        assert stat.S_ISREG(state.st_mode) and state.st_nlink==1 and state.st_uid==os.getuid() and state.st_mode&0o077==0
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            assert os.fstat(fd).st_ino==state.st_ino
            return os.read(fd,20000000).decode()
        finally: os.close(fd)
    config=json.loads(private_file(config_file))
    fixture=pathlib.Path(config['fixture'])
    root=pathlib.Path(config['root'])
    state=os.lstat(fixture)
    assert stat.S_ISDIR(state.st_mode) and state.st_uid==os.getuid() and state.st_mode&0o077==0
    assert fixture.name.startswith('native-chat-ui-') and root==fixture/'knowledge'
    assert private_file(fixture/'native-ui-fixture-token')==config['nonce']
    assert private_file(arm_file)==config['nonce']
    parent=os.getppid()
    assert parent==config['pid'] and parent>1
    ticks=pathlib.Path('/proc',str(parent),'stat').read_text().rsplit(') ',1)[1].split()[19]
    assert ticks==config['startTicks']
    argv=pathlib.Path('/proc',str(parent),'cmdline').read_bytes().split(b'\\0')
    assert [os.fsdecode(arg) for arg in argv[1:6]]==[config['host'],str(fixture),str(root),config['target'],config['nonce']]
    assert len(sys.argv)==5 and sys.argv[1]=='-c'
    assert hashlib.sha256(sys.argv[2].encode()).hexdigest()==config['programSha256']
    db=sqlite3.connect(root.as_uri()+'/core.sqlite?mode=ro',uri=True)
    try:
        row=db.execute('SELECT operation,actor_id,plan FROM pending_document_lifecycle WHERE singleton=1').fetchone()
    finally: db.close()
    assert row and row[0]=='private.native-board-lifecycle' and row[1]=='user:local'
    pending=json.loads(row[2]);event=pending['event']
    assert pending['kind']=='native-board-lifecycle' and event['boardKey']==config['boardSlug']
    assert event['input']['kind']==config['kind'] and event['beforePath']==config['path']
    if config['kind']=='move':
        plan=json.loads(pending['movePlan'])
        assert plan['boardIdentity']==event['noteId'] and plan['pairedTree']['digest']
        source=root/'notes'/plan['pairedTree']['beforePath']
        destination=root/'notes'/plan['pairedTree']['afterPath']
    else:
        plan=json.loads(pending['trashPlan'])
        assert plan['boardIdentity']==event['noteId'] and plan['area']=='notes'
        move=plan['moves'][0]
        assert len(plan['moves'])==2 and move['slot']=='assets'
        live=root/'notes'/move['originalPath'];backup=root/'notes'/'.trash'/plan['entryId']/'assets'
        source,destination=(live,backup) if config['kind']=='trash' else (backup,live)
    assert source.is_relative_to(root) and destination.is_relative_to(root) and source!=destination
    assert sys.argv[3:]==[str(source),str(destination)]
    assert source.is_dir() and not source.is_symlink() and not destination.exists()
    matched=True
except Exception:
    pass
result=subprocess.run([${JSON.stringify(python)},*sys.argv[1:]])
if matched and result.returncode==0:
    evidence=dict(config,source=str(source),destination=str(destination),operationId=event['input']['operationId'])
    fd=os.open(config['evidence'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        os.write(fd,json.dumps(evidence).encode());os.fsync(fd)
    finally: os.close(fd)
    os.unlink(arm_file)
    fd=os.open(str(fixture),os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
    os.kill(parent,signal.SIGSTOP)
sys.exit(result.returncode if result.returncode>=0 else 128-result.returncode)
`;
  fs.writeFileSync(path.join(directory, "python3"), wrapper, { flag: "wx", mode: 0o700 });
  return {
    env: { PATH: `${directory}:${process.env.PATH}` },
    recovered(proof) {
      const database = new DatabaseSync(path.join(root, "core.sqlite"), { readOnly: true });
      try {
        assert(!database.prepare("SELECT 1 FROM pending_document_lifecycle WHERE singleton=1").get());
        const row = database.prepare("SELECT payload,payload_sha256 FROM native_board_lifecycle_event WHERE operation_id=?").get(proof.operationId);
        assert(row, "The exact interrupted operation has no durable completion event.");
        const event = JSON.parse(row.payload);
        assert.equal(createHash("sha256").update(row.payload).digest("hex"), row.payload_sha256);
        assert.equal(event.boardKey, proof.boardSlug); assert.equal(event.beforePath, proof.path);
        assert.equal(event.input.kind, proof.kind);
        assert.equal(event.status, proof.kind === "trash" ? "trashed" : "active");
        const receipt = database.prepare("SELECT result FROM receipts WHERE operation_id=?").get(proof.operationId);
        assert.equal(JSON.parse(receipt.result).eventDigest, row.payload_sha256);
        return event;
      } finally { database.close(); }
    },
    arm({ broker, kind, boardSlug, notePath }) {
      const evidence = path.join(fixture, `board-file-crash-${kind}.json`);
      assert(!fs.existsSync(evidence) && !fs.existsSync(armFile));
      const config = { fixture, root, target, nonce, host, pid: broker.pid, startTicks: startTicks(broker.pid),
        kind, boardSlug, path: notePath, evidence, programSha256: createHash("sha256").update(renameNoReplaceProgram).digest("hex") };
      fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
      fs.writeFileSync(armFile, nonce, { flag: "wx", mode: 0o600 });
      return async () => {
        const deadline = Date.now() + 25000;
        while ((!fs.existsSync(evidence) || !/\nState:\s+T/.test(fs.readFileSync(`/proc/${broker.pid}/status`, "utf8"))) && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(startTicks(broker.pid), config.startTicks);
        assert(/\nState:\s+T/.test(fs.readFileSync(`/proc/${broker.pid}/status`, "utf8")), "Exact synthetic broker did not stop after the real syscall.");
        const proof = JSON.parse(fs.readFileSync(evidence, "utf8"));
        assert.equal(proof.pid, broker.pid); assert.equal(proof.nonce, nonce);
        assert(!fs.existsSync(proof.source) && fs.lstatSync(proof.destination).isDirectory());
        const database = new DatabaseSync(path.join(root, "core.sqlite"), { readOnly: true });
        try {
          const pending = JSON.parse(database.prepare("SELECT plan FROM pending_document_lifecycle WHERE singleton=1").get().plan);
          assert.equal(pending.event.input.operationId, proof.operationId);
          assert.equal(pending.event.boardKey, boardSlug);
          assert(!database.prepare("SELECT 1 FROM native_board_lifecycle_event WHERE operation_id=?").get(proof.operationId),
            "The syscall prefix must precede the durable completion receipt.");
          const markdown = path.join(root, "notes", notePath);
          if (kind === "restore") assert(!fs.existsSync(markdown));
          else assert.equal(createHash("sha256").update(fs.readFileSync(markdown)).digest("hex"), pending.event.input.expectedDocumentDigest);
        } finally { database.close(); }
        return proof;
      };
    },
  };
};
