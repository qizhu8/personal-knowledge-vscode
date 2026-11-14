const {test}=require("node:test");
const assert=require("node:assert/strict");
const {commandNoteWorkItem,readNoteWorkItems}=require("../dist/knowledge/note-work-items");

test("User Story parent contracts are validated and protected across shared commands",()=>{
  let markdown="# Original Note\n";
  const user={id:"user:local",role:"user"},worker={id:"chat:worker",role:"worker"};
  const base=(id,extra={})=>({id,title:id,goal:"User value",scope:"Bounded feature",acceptance:["Observable requirement"],state:"Planning",evidence:[],...extra});
  const apply=(command,actor=user)=>{
    markdown=commandNoteWorkItem(markdown,readNoteWorkItems(markdown).digest,command,actor);
    return readNoteWorkItems(markdown);
  };
  const rejected=(command,actor,pattern)=>{
    const before=markdown;assert.throws(()=>apply(command,actor),pattern);assert.equal(markdown,before);
  };
  apply({action:"create",item:base("story",{kind:"UserStory",storyStatus:"draft"})});
  apply({action:"create",item:base("task",{parentId:"story"})});
  rejected({action:"create",item:base("missing",{parentId:"absent"})},user,/parentId/);
  rejected({action:"create",item:base("nested",{kind:"UserStory",parentId:"story"})},user,/parent/);
  rejected({action:"create",item:base("story2",{kind:"UserStory"})},worker,/Only users/);
  rejected({action:"create",item:base("worker-task",{parentId:"story"})},worker,/Only users/);
  apply({action:"claim",id:"task"},worker);
  const task=()=>readNoteWorkItems(markdown).items.find(item=>item.id==="task");
  rejected({action:"edit",item:{...task(),parentId:undefined}},worker,/protected field: parentId/);
  const story=()=>readNoteWorkItems(markdown).items.find(item=>item.id==="story");
  rejected({action:"edit",item:{...story(),state:"Done",outcome:"Success",evidence:["test://story"]}},user,/child/);
  apply({action:"transition",id:"task",state:"Done",outcome:"Success",evidence:["test://task"]},worker);
  rejected({action:"edit",item:{...story(),state:"Done",outcome:"Success",evidence:["test://story"]}},user,/child/);
  apply({action:"accept",id:"task",reason:"Checked task evidence"});
  apply({action:"edit",item:{...story(),storyStatus:"confirmed",state:"Done",outcome:"Success",evidence:["test://story"]}});
  assert.equal(story().acceptanceDecision,undefined,"child acceptance never accepts the Story");
  rejected({action:"reopen",id:"task",reason:"Needs rework"},user,/parent User Story/);
  apply({action:"accept",id:"story",reason:"User value verified separately"});
  assert.equal(story().acceptanceDecision.by,user.id);
  apply({action:"reopen",id:"story",reason:"Scope reopened"});
  apply({action:"reopen",id:"task",reason:"Rework"});
  assert.equal(task().parentId,"story");
  assert.equal(story().state,"Planning");
  assert(markdown.startsWith("# Original Note\n"));
});
