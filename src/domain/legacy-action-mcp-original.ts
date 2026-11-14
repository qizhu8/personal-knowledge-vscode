export const ORIGINAL_LEGACY_ACTION_MCP = {
  "source": "resources/action_modules.py",
  "sha256": "8b939ae9a2de32c5cc0e99538c8ff5722f3a9c7f6f69bd169baf3675788c2a55",
  "executionContractSource": "resources/action_run_store.py",
  "executionContractSha256": "ae79232105b21940f0addc26f1fc28a125a158ec60af7558d374f3f16531c479",
  "executionContractFunction": "def action_contract(definition):\n    \"\"\"Adapt legacy metadata conservatively without granting new permissions.\"\"\"\n    effects = definition.get(\"effects\", [definition.get(\"effect\", \"unknown\")])\n    levels = {\"pure\": \"read\", \"read\": \"read\", \"local-read\": \"read\", \"remote-read\": \"read\",\n              \"human-input\": \"read\", \"local-write\": \"write\", \"remote-write\": \"write\",\n              \"send\": \"send\", \"delete\": \"delete\", \"spend\": \"spend\"}\n    normalized = sorted({levels.get(effect, \"unknown\") for effect in effects})\n    return {\"schema\": \"pkm.action.execution-contract/v1\", \"actionId\": definition[\"action_id\"],\n            \"revision\": definition[\"content_hash\"], \"effects\": normalized,\n            \"inputSchema\": definition.get(\"input_schema\"), \"outputSchema\": definition.get(\"output_schema\"),\n            \"requiredCapabilities\": sorted(set(effects)),\n            \"resourceClaims\": [{\"resource\": \"invocation-workspace\", \"access\": \"read\" if normalized == [\"read\"] else \"write\"}],\n            \"timeoutPolicy\": {\"kind\": \"deadline\", \"onTimeout\": \"reconcile\"},\n            \"retryPolicy\": {\"automatic\": False, \"reason\": \"Reconcile the original Run before any new attempt.\"},\n            \"idempotency\": {\"kind\": \"launch-key\", \"externalEffectGuaranteed\": False},\n            \"receiptContract\": \"pkm.action.execution/v1\",\n            \"reconciler\": definition.get(\"reconciler\", {\"kind\": \"manual\"})}",
  "templates": {
    "ok": true,
    "templates": [
      {
        "template_id": "wait",
        "action_id": "core.delay",
        "inputs": {
          "seconds": 30
        }
      },
      {
        "template_id": "wait-five-minutes",
        "action_id": "core.delay",
        "inputs": {
          "seconds": 300
        }
      },
      {
        "template_id": "user-input",
        "action_id": "core.ask-user"
      },
      {
        "template_id": "chatroom-alias",
        "action_id": "core.chatroom-alias"
      },
      {
        "template_id": "poll",
        "description": "Pin a read-only query Action, observe one output field until an exact value or timeout.",
        "parameters": [
          "query_action_id",
          "query_revision",
          "query_inputs",
          "field",
          "expected",
          "interval_seconds",
          "timeout_seconds",
          "max_iterations"
        ]
      },
      {
        "template_id": "monitor",
        "description": "Observe all terminal results with durable snapshots, explicit stop reasons and replayable events.",
        "parameters": [
          "template_id",
          "query_action_id",
          "query_revision",
          "query_inputs",
          "interval_seconds",
          "timeout_seconds",
          "max_iterations"
        ]
      },
      {
        "template_id": "azuredevops-pipeline-status",
        "description": "Explicit read-only host Azure CLI adapter; no credentials or live qualification by default.",
        "parameters": [
          "template_id"
        ]
      }
    ]
  },
  "proposalResult": {
    "ok": true,
    "state": "pending_operator_approval",
    "next_owner": "background",
    "proposal_id": "__proposal_id__",
    "action_id": "__action_id__",
    "content_hash": "__content_hash__",
    "registered": false,
    "callable": false,
    "next_action": "The trusted PKM Extension Host prepares this revision automatically in the background. Wait for Action readiness; no manual Validate or model selection is required. If blocked, inspect preparation details. Do not self-grant or retry registration."
  },
  "admissionRequiredReason": "ACTION_ADMISSION_REQUIRED: This Action revision is being prepared for the formal library. Wait for automatic background preparation by the trusted PKM Host. Inspect preparation details if blocked. No manual Validate is required. Do not call, self-approve, edit policy/admissions or retry registration."
} as const;
