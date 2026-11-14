const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const host = { window:{} };
const originalLoad = Module._load;
let request;
try {
  Module._load = function(name,...args) { return name === "vscode" ? host : originalLoad.call(this,name,...args); };
  ({ requestNativePortalInteraction:request } = require("../dist/chat/portal-native-interaction"));
} finally { Module._load = originalLoad; }

test("native external forms keep links secret, skip hidden direction and validate before final consent",async()=>{
  const prompts=[],picks=[];
  let confirmations=0;
  host.window.showQuickPick=async(items,options)=>{
    picks.push(options.title);
    return items.find(item=>item.value==="submit"||item.value==="Accept");
  };
  host.window.showInputBox=async options=>{prompts.push(options);return "private-link";};
  host.window.showWarningMessage=async(_title,_options,label)=>{confirmations++;return label;};
  const result=await request({title:"External setup",detail:"Private local consent",
    choices:[{value:"submit",label:"Connect"},{value:"cancel",label:"Cancel"}],
    form:{type:"object",required:["connection","role"],properties:{
      connection:{type:"string",enum:["Create","Accept"]},
      role:{type:"string",enum:["Controller","Controlled"],default:"Controller"},
      link:{type:"string"},
    }},secretFields:["link"],fieldVisibility:{role:{field:"connection",values:["Create"]},link:{field:"connection",values:["Accept"]}},
    verify:async fields=>assert.equal(fields.link,"private-link"),
  },()=>true);
  assert.deepEqual(result,{action:"submit",fields:{connection:"Accept",role:"Controller",link:"private-link"}});
  assert.equal(prompts[0].password,true);
  assert.equal(picks.length,2,"accepting must not ask for direction");
  assert.equal(confirmations,1);
});

test("native cancellation and stale confirmations never apply consent",async()=>{
  const interaction={title:"Grant",detail:"Fixed scope",choices:[{value:"confirm",label:"Allow"}]};
  let active=true;
  host.window.showWarningMessage=async()=>{active=false;return "Allow";};
  await assert.rejects(request(interaction,()=>active),/changed during confirmation/);
  host.window.showWarningMessage=async()=>undefined;
  assert.equal(await request(interaction,()=>true),undefined);
});

test("native forms retry explicit validation errors and handle multi-select, numbers and booleans",async()=>{
  let attempts=0,errors=0;
  host.window.showQuickPick=async(items,options)=>{
    if(options.canPickMany)return items;
    if(items[0].value==="submit"){attempts++;return items[0];}
    return items.find(item=>item.value===true);
  };
  host.window.showInputBox=async()=>{attempts++;return attempts===2?"":"0";};
  host.window.showErrorMessage=async message=>{assert.match(message,/Invalid answer/);errors++;return "Retry";};
  host.window.showWarningMessage=async(_title,_options,label)=>label;
  const result=await request({title:"Permissions",detail:"No renewal",choices:[{value:"submit",label:"Grant"}],
    form:{type:"object",required:["minutes"],properties:{
      permissions:{type:"array",items:{type:"string",enum:["files-read","progress-read"]}},
      minutes:{type:"number",minimum:0},longLived:{type:"boolean",default:false},
    }},verify:async fields=>assert.equal(fields.longLived,true),
  },()=>true);
  assert.equal(errors,1);
  assert.equal(result.fields.minutes,0);
  assert.deepEqual(result.fields.permissions,["files-read","progress-read"]);
});
