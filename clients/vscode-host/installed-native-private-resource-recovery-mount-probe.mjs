import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mountInstalledNativePrivateResourceRecoveryParent, assertInstalledNativePrivateResourceRecoveryMount,
  resizeInstalledNativePrivateResourceRecoveryMount, releaseInstalledNativePrivateResourceRecoveryMount,
} from "./installed-native-private-resource-recovery-mount.mjs";
import {
  prepareInstalledNativePrivateResourceRecoveryFixture, verifyInstalledNativePrivateResourceRecoveryEnospc,
  reopenInstalledNativePrivateResourceRecovery, verifyInstalledNativePrivateResourceRecoveryB1,
} from "./installed-native-private-resource-recovery.mjs";
import { installedNativeKnowledgeMovePrivacyPolicy } from "./installed-native-knowledge-move.mjs";

assert(process.env.PKM_TEST_WORKSPACE);assert(process.env.PKM_LEGACY_VSIX);
const namespaceWitness=JSON.parse(process.argv[2]),installed=resolve("clients/vscode-host"),python=process.argv[3];
const api=await import(pathToFileURL(join(installed,"next-runtime/server/dist/original-mcp-component-recovery.js")).href);
const base=join(homedir(),".local/state/pkm-v5-recovery");await mkdir(base,{recursive:true,mode:0o700});
const directory=join(base,`private-recovery-test-${randomUUID()}`);
const current=Object.fromEntries(await Promise.all(["user","mnt","net","pid"].map(async name=>[name,await readlink(`/proc/self/ns/${name}`)])));
await assert.rejects(mountInstalledNativePrivateResourceRecoveryParent({directory,namespaceWitness:current}),{code:"PRIVATE_RECOVERY_NAMESPACE_REQUIRED"});
const mount=await mountInstalledNativePrivateResourceRecoveryParent({directory,namespaceWitness});
try{
  await assert.rejects(assertInstalledNativePrivateResourceRecoveryMount({...mount}),{code:"PRIVATE_RECOVERY_ACTUAL_MOUNT_REQUIRED"});
  const componentFixture=await api.createOriginalMcpColdComponentFixture(join(directory,"fixture"));
  for(const name of ["notes","skills",".pkm"])await mkdir(join(componentFixture.root,name),{mode:0o700});
  await writeFile(join(componentFixture.root,"notes/Entry.md"),"Common Entry.\n",{mode:0o600});
  await writeFile(join(componentFixture.root,"skills/Base.md"),"Common Base.\n",{mode:0o600});
  await writeFile(join(componentFixture.root,".pkm/content-privacy.json"),JSON.stringify(installedNativeKnowledgeMovePrivacyPolicy),{mode:0o600});
  const source=await prepareInstalledNativePrivateResourceRecoveryFixture({installed,componentFixture,mount,python,legacyVsix:process.env.PKM_LEGACY_VSIX});
  assert.equal(source.environmentFaultInjection,true);assert.equal(source.passed,undefined);
  assert.equal(await readFile(join(componentFixture.root,"notes/Entry.md"),"utf8"),"Common Entry.\n");
  assert.equal(await readFile(join(componentFixture.root,"skills/Base.md"),"utf8"),"Common Base.\n");
  for(const name of ["recovery-A.PNG","recovery-B.BIN"])assert.equal((await readFile(join(componentFixture.root,"notes/Private/_assets",name))).length,2097152);
  await resizeInstalledNativePrivateResourceRecoveryMount(mount,67108864);await api.assertOriginalMcpColdComponentFixture(componentFixture);
  await assert.rejects(verifyInstalledNativePrivateResourceRecoveryEnospc({installed,sourceFixture:source,component:{fixture:componentFixture,root:componentFixture.root}}),
    {code:"INSTALLED_KNOWLEDGE_MOVE_ACTUAL_PUBLIC_COMPONENT_REQUIRED"});
  await assert.rejects(verifyInstalledNativePrivateResourceRecoveryEnospc({sourceFixture:{...source}}),{code:"PRIVATE_RECOVERY_ACTUAL_PREPARATION_REQUIRED"});
  await assert.rejects(reopenInstalledNativePrivateResourceRecovery({installed,sourceFixture:source}),{code:"PRIVATE_RECOVERY_REOPEN_ORDER_REQUIRED"});
  await assert.rejects(verifyInstalledNativePrivateResourceRecoveryB1(source,{retirement:{}}),{code:"PRIVATE_RECOVERY_CONFIRMED_CLOSED_RECOVERY_REQUIRED"});
  console.log(JSON.stringify({passed:true,actualMountedBrandAndOriginalOracle:true,unsafeNamespaceAndCopiedHandlesRefused:true,
    fakeInstalledAndPendingRecoveryRefused:true,privatePendingIntentProduced:false,installedRecoveryQualified:false}));
}finally{await releaseInstalledNativePrivateResourceRecoveryMount(mount);}
