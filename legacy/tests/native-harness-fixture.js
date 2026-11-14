const sessionId = `agent_session_${"a".repeat(32)}`;
const actionId = `action_run_${"b".repeat(32)}`;
const runId = `recipe_run_${"c".repeat(32)}`;
const childId = `recipe_run_${"d".repeat(32)}`;
function fixture() {
  return {
    sessionId, origin:"pkm-native", status:"running", task:"Native Harness acceptance fixture",
    todos:[{ todoId:"todo", title:"Implement and validate", status:"running", recipeRunIds:[runId] },
      { todoId:"ignored", title:"Unneeded deployment", status:"skipped", summary:"Explicitly ignored by user; no deployment." }],
    runs:[
      { runId, recipeName:"Development", recipeRevision:7, status:"running",
        definition:{ spec:{ name:"Pinned development v7", nodes:[{ nodeId:"debug" }] } },
        nodes:[{ nodeId:"prepare", instruction:"Prepare", state:"succeeded" },
          { nodeId:"debug", instruction:"Debug", state:"failed", childRunId:childId, dependsOn:[{ from:"prepare" }] },
          { nodeId:"skip", instruction:"Optional deployment", state:"skipped", error:"User excluded deployment.", dependsOn:[{ from:"debug" }] }] },
      { runId:childId, recipeName:"Nested debug", recipeRevision:2, status:"running", parent:{ runId, nodeId:"debug" },
        definition:{ spec:{ name:"Pinned nested debug v2" } },
        nodes:[{ nodeId:"inspect", instruction:"Inspect evidence", state:"running" }] }
    ],
    actionRuns:[{
      runId:actionId, actionId:"fixture.script", state:"succeeded", inputs:{ dryRun:true },
      execution:{ phase:"completed", receipts:[{ operation:"completed", at:1 }] },
      steps:[{ key:"branch", state:"completed", output:{ condition:true } },
        { key:"branch/then/skipped", state:"ignored", reason:"Explicit runtime receipt: unnecessary component." }]
    }],
    harness:{ state:"running", currentProblem:"Debug without deployment", currentProblemSource:"user-input", attempts:[
      { messageId:"m1", attemptId:"a1", attempt:1, taskId:"todo", inputId:"u1", status:"failed",
        associatedProblem:"Fix the failing test", model:"fixture-model", response:"First attempt failed.",
        progress:{ status:"failed", transitions:[{ label:"Calling tool", at:1, status:"failed" }], droppedSteps:2 },
        toolCalls:[{ id:"call1", name:"run_process", status:"failed", arguments:'{"command":"<script>not code</script>"}',
          resultPreview:"x".repeat(2000), resultCharacters:2001, resultTruncated:true }] },
      { messageId:"m2", attemptId:"a2", retryOf:"a1", attempt:2, taskId:"todo", inputId:"u1", status:"running",
        associatedProblem:"Fix the failing test", response:"",
        planning:{ recipeRunId:runId, possibilities:[
          { id:"p", label:"Inspect input", status:"selected" },
          { id:"nested", parentId:"p", label:"Check fixtures", status:"candidate" },
          { id:"reject", label:"Redeploy", status:"rejected", reason:"No deployment allowed." }
        ] },
        retrieval:[{ kind:"selection", receipt:{ candidates:[{ label:"Candidate only" }] } },
          { kind:"sent-round", receipt:{ candidates:[{ label:"Actually sent" }] } }],
        toolCalls:[{ id:"call2", name:"mcp_action_call", status:"complete", arguments:'{"dryRun":true}', resultPreview:'{"state":"succeeded"}',
          resultCharacters:21, resultTruncated:false, actionRunIds:[actionId] }] }
    ] }
  };
}
module.exports = { fixture, sessionId, actionId, runId, childId };
