export const originalActionCompilerFixtures = {
  "example": {
    "schema": "pkm.action.definition/v1",
    "action_id": "example.cli.echo",
    "version": 1,
    "description": "Bounded stdin/stdout JSON program, not a shell.",
    "input_schema": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    },
    "effects": [
      "pure"
    ],
    "implementations": [
      {
        "id": "python",
        "kind": "program",
        "platforms": [
          "Linux",
          "Windows",
          "Darwin"
        ],
        "program": "python",
        "args": [
          "-c",
          "import json,sys; value=json.load(sys.stdin); print(json.dumps({'value':value['value']}))"
        ]
      }
    ],
    "examples": [
      {
        "inputs": {
          "value": "hello"
        },
        "output": {
          "value": "hello"
        }
      }
    ]
  },
  "diagnostics": [
    {
      "id": "unsupported-kind",
      "definition": {
        "schema": "pkm.action.definition/v1",
        "action_id": "example.cli.echo",
        "version": 1,
        "description": "Bounded stdin/stdout JSON program, not a shell.",
        "input_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "output_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "effects": [
          "pure"
        ],
        "implementations": [
          {
            "id": "python",
            "kind": "command",
            "platforms": [
              "Linux",
              "Windows",
              "Darwin"
            ],
            "program": "python",
            "args": [
              "-c",
              "import json,sys; value=json.load(sys.stdin); print(json.dumps({'value':value['value']}))"
            ]
          }
        ],
        "examples": [
          {
            "inputs": {
              "value": "hello"
            },
            "output": {
              "value": "hello"
            }
          }
        ]
      },
      "diagnostics": [
        {
          "path": "/implementations/0/kind",
          "code": "enum",
          "message": "Choose a supported implementation kind.",
          "allowed_values": [
            "program",
            "pipeline",
            "mcp"
          ]
        }
      ]
    },
    {
      "id": "missing-program",
      "definition": {
        "schema": "pkm.action.definition/v1",
        "action_id": "example.cli.echo",
        "version": 1,
        "description": "Bounded stdin/stdout JSON program, not a shell.",
        "input_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "output_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "effects": [
          "pure"
        ],
        "implementations": [
          {
            "id": "python",
            "kind": "program",
            "platforms": [
              "Linux",
              "Windows",
              "Darwin"
            ],
            "args": [
              "-c",
              "import json,sys; value=json.load(sys.stdin); print(json.dumps({'value':value['value']}))"
            ]
          }
        ],
        "examples": [
          {
            "inputs": {
              "value": "hello"
            },
            "output": {
              "value": "hello"
            }
          }
        ]
      },
      "diagnostics": [
        {
          "path": "/implementations/0/program",
          "code": "required",
          "message": "Required field is missing.",
          "missing_field": "program"
        }
      ]
    },
    {
      "id": "unsupported-platform",
      "definition": {
        "schema": "pkm.action.definition/v1",
        "action_id": "example.cli.echo",
        "version": 1,
        "description": "Bounded stdin/stdout JSON program, not a shell.",
        "input_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "output_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "effects": [
          "pure"
        ],
        "implementations": [
          {
            "id": "python",
            "kind": "program",
            "platforms": [
              "linux"
            ],
            "program": "python",
            "args": [
              "-c",
              "import json,sys; value=json.load(sys.stdin); print(json.dumps({'value':value['value']}))"
            ]
          }
        ],
        "examples": [
          {
            "inputs": {
              "value": "hello"
            },
            "output": {
              "value": "hello"
            }
          }
        ]
      },
      "diagnostics": [
        {
          "path": "/implementations/0/platforms/0",
          "code": "enum",
          "message": "'linux' is not one of ['Linux', 'Windows', 'Darwin']",
          "allowed_values": [
            "Linux",
            "Windows",
            "Darwin"
          ]
        }
      ]
    },
    {
      "id": "invalid-args",
      "definition": {
        "schema": "pkm.action.definition/v1",
        "action_id": "example.cli.echo",
        "version": 1,
        "description": "Bounded stdin/stdout JSON program, not a shell.",
        "input_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "output_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "effects": [
          "pure"
        ],
        "implementations": [
          {
            "id": "python",
            "kind": "program",
            "platforms": [
              "Linux",
              "Windows",
              "Darwin"
            ],
            "program": "python",
            "args": "python -c"
          }
        ],
        "examples": [
          {
            "inputs": {
              "value": "hello"
            },
            "output": {
              "value": "hello"
            }
          }
        ]
      },
      "diagnostics": [
        {
          "path": "/implementations/0/args",
          "code": "type",
          "message": "'python -c' is not of type 'array'"
        }
      ]
    },
    {
      "id": "invalid-input-schema",
      "definition": {
        "schema": "pkm.action.definition/v1",
        "action_id": "example.cli.echo",
        "version": 1,
        "description": "Bounded stdin/stdout JSON program, not a shell.",
        "input_schema": {
          "type": "bogus",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "output_schema": {
          "type": "object",
          "properties": {
            "value": {
              "type": "string"
            }
          },
          "required": [
            "value"
          ],
          "additionalProperties": false
        },
        "effects": [
          "pure"
        ],
        "implementations": [
          {
            "id": "python",
            "kind": "program",
            "platforms": [
              "Linux",
              "Windows",
              "Darwin"
            ],
            "program": "python",
            "args": [
              "-c",
              "import json,sys; value=json.load(sys.stdin); print(json.dumps({'value':value['value']}))"
            ]
          }
        ],
        "examples": [
          {
            "inputs": {
              "value": "hello"
            },
            "output": {
              "value": "hello"
            }
          }
        ]
      },
      "diagnostics": [
        {
          "path": "/input_schema/type",
          "code": "anyOf",
          "message": "'bogus' is not valid under any of the given schemas"
        }
      ]
    }
  ],
  "orderedDiagnostics": [
    {
      "path": "/action_id",
      "code": "pattern",
      "message": "'x' does not match '^[a-z][a-z0-9_.-]{2,100}$'"
    },
    {
      "path": "/effects",
      "code": "minItems",
      "message": "[] should be non-empty"
    },
    {
      "path": "/implementations/0/platforms/0",
      "code": "enum",
      "message": "'linux' is not one of ['Linux', 'Windows', 'Darwin']",
      "allowed_values": [
        "Linux",
        "Windows",
        "Darwin"
      ]
    }
  ],
  "orderedDefinition": {
    "schema": "pkm.action.definition/v1",
    "action_id": "x",
    "version": 1,
    "description": "Bounded stdin/stdout JSON program, not a shell.",
    "input_schema": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    },
    "effects": [],
    "implementations": [
      {
        "id": "python",
        "kind": "program",
        "platforms": [
          "linux"
        ],
        "program": "python",
        "args": [
          "-c",
          "import json,sys; value=json.load(sys.stdin); print(json.dumps({'value':value['value']}))"
        ]
      }
    ],
    "examples": [
      {
        "inputs": {
          "value": "hello"
        },
        "output": {
          "value": "hello"
        }
      }
    ]
  },
  "moduleSet": {
    "schema": "pkm.action.module-set/v1",
    "module_set_id": "example.authoring",
    "version": 1,
    "name": "Example authoring fixture",
    "actions": [
      "example.cli.echo"
    ],
    "provenance": {},
    "files": {
      "definitions/example.cli.echo.json": "14e6675af9a7eee5325dc34b62a53c76f6d36bf5544cff04182563fd4724798a"
    },
    "package_hash": "10bc92fddb943901f1fcc96842616a367bef516fa5aa26a31cd8d775a8162950"
  },
  "moduleSetFile": "{\"action_id\": \"example.cli.echo\", \"description\": \"Bounded stdin/stdout JSON program, not a shell.\", \"effects\": [\"pure\"], \"examples\": [{\"inputs\": {\"value\": \"hello\"}, \"output\": {\"value\": \"hello\"}}], \"implementations\": [{\"args\": [\"-c\", \"import json,sys; value=json.load(sys.stdin); print(json.dumps({'value':value['value']}))\"], \"id\": \"python\", \"kind\": \"program\", \"platforms\": [\"Linux\", \"Windows\", \"Darwin\"], \"program\": \"python\"}], \"input_schema\": {\"additionalProperties\": false, \"properties\": {\"value\": {\"type\": \"string\"}}, \"required\": [\"value\"], \"type\": \"object\"}, \"knowledgeId\": \"action_8131b160d430324a78c59114\", \"output_schema\": {\"additionalProperties\": false, \"properties\": {\"value\": {\"type\": \"string\"}}, \"required\": [\"value\"], \"type\": \"object\"}, \"schema\": \"pkm.action.definition/v1\", \"version\": 1}",
  "originalRuntimeContentHash": "aa60284f767a6a6d488338a9d6dc1a81e13358e69cbfa9a4d0c17182a6986d20",
  "originalRuntimeDigest": "e1a12ac19a1be6b86522158e2b5e5cbcadeecd5c57109c31d67448e465ac2b7e",
  "componentEngineHash": "200079020024367d0a72717d6de36ee8d9bd7005a2bb356e96edd3acb23f2a05",
  "sourceHashes": {
    "resources/action_modules.py": "05dc0cdda14163eb41fb713cf69e2069dd99e681df1e721d49f3dbdda3014697",
    "resources/action_run_store.py": "ae79232105b21940f0addc26f1fc28a125a158ec60af7558d374f3f16531c479",
    "resources/action_recovery.py": "7ff3d346e19964419001c4c1e8b642bfef5380596cd810f01a532c7d6573d5bc",
    "resources/recipe_runtime.py": "2342ea420959b25e80394e18ea0a8c4c4dca43bb2231a41837c3f6920a5ce41a"
  },
  "builtins": {
    "core.date.parse": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "pure"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "builtin",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ]
        }
      ],
      "action_id": "core.date.parse",
      "description": "Validate an explicit calendar date",
      "input_schema": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "format": "date"
          }
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "date": {
            "type": "string",
            "format": "date"
          }
        },
        "required": [
          "date"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "value": "2026-10-07"
          },
          "output": {
            "date": "2026-10-07"
          }
        }
      ],
      "knowledgeId": "action_5cbbd79ef4edbfa6bd86f99e",
      "source_id": "pkm://knowledge/action_5cbbd79ef4edbfa6bd86f99e",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "8137140f15ba36ca30a8f16cccf52b070a08261749dcc84e82f0600f23a894d4"
    },
    "core.cast.integer-to-string": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "pure"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "builtin",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ]
        }
      ],
      "action_id": "core.cast.integer-to-string",
      "description": "Integer to String",
      "input_schema": {
        "type": "object",
        "properties": {
          "value": {
            "type": "integer",
            "minimum": -9223372036854776000,
            "maximum": 9223372036854776000
          }
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string"
          }
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "value": 42
          },
          "output": {
            "value": "42"
          }
        }
      ],
      "knowledgeId": "action_c4014c007d5da8450e879fa3",
      "source_id": "pkm://knowledge/action_c4014c007d5da8450e879fa3",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "9209592b6721731b6378469f27a806584e3f57e3ae3dbdce96b76e174383fb9d"
    },
    "core.cast.string-to-integer": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "pure"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "builtin",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ]
        }
      ],
      "action_id": "core.cast.string-to-integer",
      "description": "String to Integer",
      "input_schema": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string"
          }
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "value": {
            "type": "integer",
            "minimum": -9223372036854776000,
            "maximum": 9223372036854776000
          }
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "value": "42"
          },
          "output": {
            "value": 42
          }
        }
      ],
      "knowledgeId": "action_f641acccf5d7ac361d113df5",
      "source_id": "pkm://knowledge/action_f641acccf5d7ac361d113df5",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "d58078ff7a9ee122f5b546d042c4fd2b2f02b0c4e2a02d38a8ba7af2a35351f1"
    },
    "core.cast.string-to-float": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "pure"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "builtin",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ]
        }
      ],
      "action_id": "core.cast.string-to-float",
      "description": "String to Float",
      "input_schema": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string"
          },
          "trim": {
            "type": "boolean",
            "default": false
          }
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "value": {
            "type": "number"
          }
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "value": "3.25"
          },
          "output": {
            "value": 3.25
          }
        },
        {
          "inputs": {
            "value": " 1.5e2 ",
            "trim": true
          },
          "output": {
            "value": 150
          }
        }
      ],
      "knowledgeId": "action_5a01e0219fc12978fe3acc6b",
      "source_id": "pkm://knowledge/action_5a01e0219fc12978fe3acc6b",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "947bfa943379b25f3ff88e7f6c2c5298ef067375e69f4dcc96286c9bee17e58e"
    },
    "core.artifact.write": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "local-read",
        "local-write"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "builtin",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ]
        }
      ],
      "action_id": "core.artifact.write",
      "description": "Write managed UTF-8 text",
      "input_schema": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "maxLength": 65536
          }
        },
        "required": [
          "text"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "artifact_id": {
            "type": "string",
            "pattern": "^artifact_[0-9a-f]{32}$"
          }
        },
        "required": [
          "artifact_id"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "text": "non-private Action fixture"
          }
        }
      ],
      "knowledgeId": "action_1cec12b816fb2f371cb5d1f7",
      "source_id": "pkm://knowledge/action_1cec12b816fb2f371cb5d1f7",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "95f116e3b17c63af64ba369658d0873e9cb605314b4b23f93bb6413005a632ac"
    },
    "core.artifact.copy": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "local-read",
        "local-write"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "builtin",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ]
        }
      ],
      "action_id": "core.artifact.copy",
      "description": "Copy a referenced managed artifact into a new managed artifact owned by this run",
      "input_schema": {
        "type": "object",
        "properties": {
          "source": {
            "type": "object",
            "properties": {
              "artifact_id": {
                "type": "string",
                "pattern": "^artifact_[0-9a-f]{32}$"
              }
            },
            "required": [
              "artifact_id"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "source"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "artifact_id": {
            "type": "string",
            "pattern": "^artifact_[0-9a-f]{32}$"
          }
        },
        "required": [
          "artifact_id"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "source": {
              "artifact_id": "artifact_00000000000000000000000000000000"
            }
          }
        }
      ],
      "knowledgeId": "action_68b5c9e78ad3511a16dfefc9",
      "source_id": "pkm://knowledge/action_68b5c9e78ad3511a16dfefc9",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "021c0cd52574d89dca060c78d66c483537ef0b73fd4dfc6c2931c27af58cfbcd"
    },
    "core.delay": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "pure"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "pipeline",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ],
          "steps": [
            {
              "id": "request",
              "component": "core.sleep",
              "inputs": {
                "seconds": {
                  "$input": "seconds"
                }
              }
            }
          ],
          "output": {
            "seconds": {
              "$step": "request.seconds"
            }
          }
        }
      ],
      "action_id": "core.delay",
      "description": "Wait for a duration (30 seconds, 5 minutes); durable timer, no busy worker.",
      "input_schema": {
        "type": "object",
        "properties": {
          "seconds": {
            "type": "number",
            "minimum": 0,
            "maximum": 300
          }
        },
        "required": [
          "seconds"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "seconds": {
            "type": "number"
          }
        },
        "required": [
          "seconds"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "seconds": 0
          }
        }
      ],
      "knowledgeId": "action_b7bc36569b48bd2ef4c03286",
      "source_id": "pkm://knowledge/action_b7bc36569b48bd2ef4c03286",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "c4114dcf37dfc18a56234385612bb7bf0b156570795f9e25197c073b3f9b4917"
    },
    "core.ask-user": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "human-input"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "pipeline",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ],
          "steps": [
            {
              "id": "request",
              "component": "core.checkpoint",
              "inputs": {
                "kind": "input",
                "proposal": {
                  "prompt": {
                    "$input": "prompt"
                  }
                },
                "answer_schema": {
                  "$input": "answer_schema"
                },
                "test_answer": {
                  "$input": "test_answer"
                }
              }
            }
          ],
          "output": {
            "value": {
              "$step": "request.value"
            }
          }
        }
      ],
      "action_id": "core.ask-user",
      "description": "Ask the user inside Chat using an explicit answer schema. Never request secrets.",
      "input_schema": {
        "type": "object",
        "properties": {
          "prompt": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "answer_schema": {
            "type": "object"
          },
          "test_answer": {
            "type": "object"
          }
        },
        "required": [
          "prompt",
          "answer_schema",
          "test_answer"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "value": {}
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "prompt": "Choose a fixture label",
            "answer_schema": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string"
                }
              },
              "required": [
                "label"
              ],
              "additionalProperties": false
            },
            "test_answer": {
              "label": "fixture"
            }
          }
        }
      ],
      "knowledgeId": "action_261d92718c08320eb048f5e0",
      "source_id": "pkm://knowledge/action_261d92718c08320eb048f5e0",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "6011f821fd9d0167081225dfcaa5b56fcb0fc23209ddd7f2e09a04808072f915"
    },
    "core.chatroom-alias": {
      "schema": "pkm.action.definition/v1",
      "version": 1,
      "dependencies": {},
      "casts": {},
      "effects": [
        "human-input"
      ],
      "implementations": [
        {
          "id": "native",
          "kind": "pipeline",
          "platforms": [
            "Linux",
            "Windows",
            "Darwin"
          ],
          "steps": [
            {
              "id": "request",
              "component": "core.checkpoint",
              "inputs": {
                "kind": "input",
                "proposal": {
                  "prompt": "Choose the alias for this agent before joining the Chatroom.",
                  "room": {
                    "$input": "room"
                  }
                },
                "answer_schema": {
                  "type": "object",
                  "properties": {
                    "alias": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^\\S(?:[^\\x00-\\x1f\\x7f]*\\S)?$"
                    }
                  },
                  "required": [
                    "alias"
                  ],
                  "additionalProperties": false
                },
                "test_answer": {
                  "alias": "fixture-agent"
                }
              }
            }
          ],
          "output": {
            "value": {
              "$step": "request.value"
            }
          }
        }
      ],
      "action_id": "core.chatroom-alias",
      "description": "Before joining a Chatroom, ask the user for the agent alias; never invent one.",
      "input_schema": {
        "type": "object",
        "properties": {
          "room": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          }
        },
        "required": [
          "room"
        ],
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "value": {}
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      },
      "examples": [
        {
          "inputs": {
            "room": "fixture-room"
          }
        }
      ],
      "knowledgeId": "action_6994929f77908ce4be09a77c",
      "source_id": "pkm://knowledge/action_6994929f77908ce4be09a77c",
      "implementation_hash": "a695f18cf4c6a21900575b141656626d7db70d65a9027c3cccaef6eef8903b74",
      "content_hash": "f7df45b7161ed86bbacf5234976717989f4841cf31e6ee56db52a1fdbfa10cf2"
    }
  }
};

export const originalActionCompilerSource = {"action_authoring":{"definition_schema":"def definition_schema():\n    strings = {\"type\": \"array\", \"items\": {\"type\": \"string\"}}\n    executable = {\"type\": \"object\", \"required\": [\"program\"], \"properties\": {\n        \"program\": {\"type\": \"string\", \"minLength\": 1}, \"args\": strings, \"files\": strings}}\n    build = {\"type\": \"object\", \"required\": [\"program\", \"args\", \"source_files\", \"outputs\"], \"properties\": {\n        **executable[\"properties\"], \"source_files\": {**strings, \"minItems\": 1},\n        \"outputs\": {**strings, \"minItems\": 1}, \"timeout_seconds\": {\"type\": \"number\"}}}\n    common = {\"id\": {\"type\": \"string\"},\n              \"platforms\": {\"type\": \"array\", \"minItems\": 1, \"items\": {\"enum\": PLATFORMS}},\n              \"architectures\": strings, \"files\": strings, \"build\": build}\n    variants = []\n    for kind, fields, required in [\n        (\"program\", {**executable[\"properties\"], \"result_protocol\": {\"const\": \"pkm.action.result/v1\"}}, [\"program\"]),\n        (\"pipeline\", {\"steps\": {\"type\": \"array\", \"items\": {\"type\": \"object\"}},\n                      \"output\": {\"type\": \"object\"}, \"observation_monitor\": {\"type\": \"boolean\"}}, [\"steps\"]),\n        (\"mcp\", {\"server\": executable, \"tool\": {\"type\": \"string\", \"minLength\": 1},\n                 \"input_schema_hash\": {\"type\": \"string\", \"pattern\": \"^[a-f0-9]{64}$\"},\n                 \"output_schema_hash\": {\"type\": \"string\", \"pattern\": \"^[a-f0-9]{64}$\"},\n                 \"read_only\": {\"type\": \"boolean\"}},\n         [\"server\", \"tool\", \"input_schema_hash\", \"output_schema_hash\"]),\n    ]:\n        variants.append({\"type\": \"object\", \"required\": [\"kind\", \"platforms\", *required],\n                         \"properties\": {**common, **fields, \"kind\": {\"const\": kind}}})\n    json_schema = {\"$ref\": \"https://json-schema.org/draft/2020-12/schema\"}\n    return {\"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n            \"title\": \"PKM Action registration definition\", \"type\": \"object\",\n            \"required\": [\"schema\", \"action_id\", \"version\", \"input_schema\", \"output_schema\",\n                         \"effects\", \"implementations\"],\n            \"additionalProperties\": False,\n            \"properties\": {\n                \"schema\": {\"const\": \"pkm.action.definition/v1\"},\n                \"action_id\": {\"type\": \"string\", \"pattern\": \"^[a-z][a-z0-9_.-]{2,100}$\"},\n                \"version\": {\"type\": \"integer\"},\n                \"description\": {\"type\": \"string\"}, \"display_name\": {\"type\": \"string\"},\n                \"input_schema\": json_schema, \"output_schema\": json_schema,\n                \"effects\": {\"type\": \"array\", \"minItems\": 1, \"items\": {\"type\": \"string\"}},\n                \"implementations\": {\"type\": \"array\", \"minItems\": 1, \"items\": {\"oneOf\": variants}},\n                \"dependencies\": {\"type\": \"object\", \"additionalProperties\": {\n                    \"type\": \"string\", \"pattern\": \"^[a-f0-9]{64}$\"}},\n                \"casts\": {\"type\": \"object\"},\n                \"examples\": {\"type\": \"array\", \"items\": {\"type\": \"object\", \"required\": [\"inputs\"],\n                    \"properties\": {\"inputs\": {\"type\": \"object\"}, \"output\": {}}}},\n                \"graph\": {\"type\": \"object\"}, \"provenance\": {\"type\": \"object\"},\n                \"reconciler\": {\"type\": \"object\"}}}","definition_diagnostics":"def definition_diagnostics(definition):\n    def pointer(parts):\n        return \"/\" + \"/\".join(str(part).replace(\"~\", \"~0\").replace(\"/\", \"~1\") for part in parts)\n\n    def diagnostic(error, prefix=()):\n        parts = [*prefix, *error.path]\n        if error.validator == \"oneOf\" and isinstance(error.instance, dict):\n            kind = error.instance.get(\"kind\")\n            if kind not in KINDS:\n                return [{\"path\": pointer([*parts, \"kind\"]), \"code\": \"enum\",\n                         \"message\": \"Choose a supported implementation kind.\", \"allowed_values\": KINDS}]\n            branch = error.schema[\"oneOf\"][KINDS.index(kind)]\n            return [item for child in Draft202012Validator(branch).iter_errors(error.instance)\n                    for item in diagnostic(child, parts)]\n        if error.validator == \"required\":\n            return [{\"path\": pointer([*parts, field]), \"code\": \"required\",\n                     \"message\": \"Required field is missing.\", \"missing_field\": field}\n                    for field in error.validator_value if field not in error.instance]\n        item = {\"path\": pointer(parts), \"code\": str(error.validator), \"message\": error.message}\n        if error.validator == \"enum\":\n            item[\"allowed_values\"] = error.validator_value\n        return [item]\n\n    return [item for error in Draft202012Validator(definition_schema()).iter_errors(definition)\n            for item in diagnostic(error)]"},"action_modules":{"definition_value":"def definition_value(self, value):\n        action_id = value[\"action_id\"]\n        value = {**value, \"knowledgeId\": value.get(\"knowledgeId\", \"action_\" + digest(action_id)[:24])}\n        value[\"source_id\"] = \"pkm://knowledge/\" + value[\"knowledgeId\"]\n        value[\"implementation_hash\"] = digest({\"module\": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),\n                                             \"run_store\": hashlib.sha256(Path(__file__).with_name(\"action_run_store.py\").read_bytes()).hexdigest(),\n                                             \"recovery\": hashlib.sha256(Path(__file__).with_name(\"action_recovery.py\").read_bytes()).hexdigest(),\n                                             \"components\": component_engine_hash(),\n                                             \"worker\": hashlib.sha256(Path(__file__).with_name(\"recipe_runtime.py\").read_bytes()).hexdigest()})\n        value[\"content_hash\"] = digest(value)\n        return value","dependency_closure":"def dependency_closure(self, action_id, dependencies):\n        visited = set()\n        def visit(name, pins, ancestry):\n            if len(ancestry) > 16 or len(visited) > 500:\n                raise ValueError(\"Nested Action dependency budget exceeded.\")\n            for child, pin in pins.items():\n                if child in ancestry:\n                    raise ValueError(\"Nested Action cycle: \" + \" -> \".join(ancestry + [child]))\n                definition = self.definition(child)\n                if definition[\"content_hash\"] != pin:\n                    raise ValueError(\"Dependency is not pinned to the current contract: \" + child)\n                if child not in visited:\n                    visit(child, definition[\"dependencies\"], ancestry + [child])\n                    visited.add(child)\n        visit(action_id, dependencies, [action_id])","validate_definition":"def validate_definition(self, definition):\n        diagnostics = definition_diagnostics(definition)\n        if diagnostics:\n            raise ValueError(json.dumps({\"error\": \"invalid_action_definition\", \"diagnostics\": diagnostics}))\n        allowed = {\"schema\", \"action_id\", \"version\", \"description\", \"input_schema\", \"output_schema\",\n                   \"effects\", \"implementations\", \"dependencies\", \"casts\", \"examples\", \"display_name\", \"graph\", \"provenance\", \"reconciler\"}\n        if not isinstance(definition, dict) or set(definition) - allowed:\n            raise ValueError(\"Unsupported Action definition fields.\")\n        if \"reconciler\" in definition:\n            validate_reconciler(definition[\"reconciler\"])\n        name = definition.get(\"action_id\")\n        if not isinstance(name, str) or not re.fullmatch(r\"[a-z][a-z0-9_.-]{2,100}\", name) or name in builtin_definitions() or name in component_definitions():\n            raise ValueError(\"Invalid or reserved Action ID.\")\n        if definition.get(\"schema\") != \"pkm.action.definition/v1\" or type(definition.get(\"version\")) is not int:\n            raise ValueError(\"A versioned Action definition is required.\")\n        for key in [\"input_schema\", \"output_schema\"]:\n            Draft202012Validator.check_schema(definition[key])\n        if not definition.get(\"implementations\") or not definition.get(\"effects\"):\n            raise ValueError(\"Declare implementations and effects.\")\n        for implementation in definition[\"implementations\"]:\n            if implementation.get(\"kind\") not in {\"program\", \"pipeline\", \"mcp\"} or not implementation.get(\"platforms\"):\n                raise ValueError(\"Declare a supported implementation kind and platforms.\")\n            if implementation[\"kind\"] == \"program\":\n                if not isinstance(implementation.get(\"args\", []), list) or any(not isinstance(arg, str) for arg in implementation.get(\"args\", [])):\n                    raise ValueError(\"Program args must be a string array, never a shell command.\")\n                build = implementation.get(\"build\")\n                if build is not None:\n                    if not isinstance(build, dict) or not isinstance(build.get(\"program\"), str) or not build.get(\"source_files\") or not build.get(\"outputs\"):\n                        raise ValueError(\"Build requires a compiler, source_files and outputs.\")\n                    if not isinstance(build.get(\"args\"), list) or any(not isinstance(arg, str) for arg in build[\"args\"]):\n                        raise ValueError(\"Build args must be an argv array.\")\n                    for output in build[\"outputs\"]:\n                        if not isinstance(output, str) or not output or Path(output).is_absolute() or \"..\" in Path(output).parts or \"\\\\\" in output or \":\" in output:\n                            raise ValueError(\"Build outputs must be safe relative paths.\")\n            if implementation[\"kind\"] == \"pipeline\":\n                effects = validate_steps(implementation.get(\"steps\"), definition.get(\"dependencies\", {}))\n                if not effects.issubset(set(definition[\"effects\"])):\n                    raise ValueError(\"Basic component effects must be declared by the parent Action.\")","definition_check":"def definition_check(self, definition):\n        diagnostics = definition_diagnostics(definition)\n        if not diagnostics:\n            try:\n                self.validate_definition(definition)\n                self.dependency_closure(definition[\"action_id\"], definition.get(\"dependencies\", {}))\n                path = self.registry / (definition[\"action_id\"] + \".json\")\n                if path.exists() and definition[\"version\"] <= json.loads(path.read_text(encoding=\"utf-8\"))[\"version\"]:\n                    diagnostics.append({\"path\": \"/version\", \"code\": \"revision\",\n                                        \"message\": \"Updating an Action requires a larger version.\"})\n            except (ValueError, KeyError, FileNotFoundError) as error:\n                diagnostics.append({\"path\": \"/\", \"code\": \"semantic\", \"message\": str(error)})\n        return {\"schema\": \"pkm.action.definition-check/v1\", \"ok\": not diagnostics,\n                \"diagnostics\": diagnostics, \"persisted\": False, \"executed\": False,\n                \"readiness_checked\": False,\n                \"next_action\": \"action_register\" if not diagnostics else \"fix_definition\"}","graph_definition":"def graph_definition(self, graph):\n        if not isinstance(graph, dict) or not isinstance(graph.get(\"nodes\"), list) or not 1 <= len(graph[\"nodes\"]) <= 100 or len(graph.get(\"edges\", [])) > 500:\n            raise ValueError(\"A graph needs 1-100 blocks and at most 500 connections.\")\n        nodes = {}\n        dependencies = {}\n        effects = set()\n        for node in graph[\"nodes\"]:\n            identifier = node.get(\"id\")\n            if not isinstance(identifier, str) or not re.fullmatch(r\"[a-z][a-z0-9_-]{0,63}\", identifier) or identifier in nodes:\n                raise ValueError(\"Duplicate or invalid block ID.\")\n            basic = node[\"action_id\"] in component_definitions()\n            definition = self.component(node[\"action_id\"], node.get(\"value_type\")) if basic else self.definition(node[\"action_id\"])\n            if node.get(\"content_hash\") != definition[\"content_hash\"]:\n                raise ValueError(\"Block contract changed: \" + identifier)\n            parameters = dict(node.get(\"parameters\", {}))\n            properties = definition[\"input_schema\"].get(\"properties\", {})\n            if set(parameters) - set(properties):\n                raise ValueError(\"Unknown block parameter: \" + identifier)\n            for field, value in parameters.items():\n                check(properties[field], value)\n            implementation = node.get(\"implementation\", \"python\") if basic else None\n            if basic and implementation not in {item[\"id\"] for item in definition[\"component_implementations\"]}:\n                raise ValueError(\"Unsupported block implementation: \" + identifier)\n            nodes[identifier] = {\"definition\": definition, \"inputs\": parameters, \"predecessors\": set(), \"basic\": basic,\n                                 \"implementation\": implementation}\n            if not basic:\n                dependencies[definition[\"action_id\"]] = definition[\"content_hash\"]\n            else:\n                for child in referenced_actions([{\"id\": identifier, \"component\": node[\"action_id\"], \"inputs\": parameters}]):\n                    child_definition = self.definition(child)\n                    dependencies[child] = child_definition[\"content_hash\"]\n                    effects.update(child_definition[\"effects\"])\n            effects.update(definition[\"effects\"])\n        connected = set()\n        for edge in graph.get(\"edges\", []):\n            source, target = nodes[edge[\"source\"]], nodes[edge[\"target\"]]\n            source_schema = source[\"definition\"][\"output_schema\"].get(\"properties\", {}).get(edge[\"output\"])\n            target_schema = target[\"definition\"][\"input_schema\"].get(\"properties\", {}).get(edge[\"input\"])\n            if source_schema is None or target_schema is None or target_schema != {} and digest(source_schema) != digest(target_schema):\n                raise ValueError(\"Incompatible typed ports; use an explicit conversion block.\")\n            key = (edge[\"target\"], edge[\"input\"])\n            if key in connected:\n                raise ValueError(\"An input port accepts only one source.\")\n            connected.add(key)\n            target[\"inputs\"][edge[\"input\"]] = {\"$step\": edge[\"source\"] + \".\" + edge[\"output\"]}\n            target[\"predecessors\"].add(edge[\"source\"])\n        steps = []\n        remaining = dict(nodes)\n        while remaining:\n            eligible = [identifier for identifier, node in remaining.items() if not node[\"predecessors\"].intersection(remaining)]\n            if not eligible:\n                raise ValueError(\"Action graph has a cycle.\")\n            for identifier in eligible:\n                node = remaining.pop(identifier)\n                if set(node[\"definition\"][\"input_schema\"].get(\"required\", [])) - set(node[\"inputs\"]):\n                    raise ValueError(\"Missing required block inputs: \" + identifier)\n                steps.append({\"id\": identifier, \"component\" if node[\"basic\"] else \"action_id\": node[\"definition\"][\"action_id\"], \"inputs\": node[\"inputs\"],\n                              **({\"output_schema\": node[\"definition\"][\"output_schema\"]} if node[\"basic\"] else {}),\n                              **({\"implementation\": node[\"implementation\"]} if node[\"basic\"] and node[\"implementation\"] != \"python\" else {})})\n        output_node = graph.get(\"output_node\", steps[-1][\"id\"])\n        if output_node not in nodes:\n            raise ValueError(\"Select a valid output block.\")\n        output_schema = nodes[output_node][\"definition\"][\"output_schema\"]\n        if output_schema.get(\"type\") != \"object\" or not output_schema.get(\"properties\"):\n            raise ValueError(\"Graph output requires named object ports.\")\n        self.completed_dependencies(graph[\"action_id\"], dependencies)\n        effects.update(validate_steps(steps, dependencies))\n        return {\"schema\": \"pkm.action.definition/v1\", \"action_id\": graph[\"action_id\"], \"version\": graph.get(\"version\", 1),\n                \"display_name\": graph.get(\"name\", graph[\"action_id\"]), \"description\": graph.get(\"name\", \"Graphical Action composition\"),\n                \"graph\": graph, \"input_schema\": object_schema({}), \"output_schema\": output_schema,\n                \"effects\": sorted(effects), \"dependencies\": dependencies,\n                \"implementations\": [{\"kind\": \"pipeline\", \"platforms\": [\"Linux\", \"Windows\", \"Darwin\"], \"steps\": steps,\n                    \"output\": {field: {\"$step\": output_node + \".\" + field} for field in output_schema[\"properties\"]}}], \"examples\": [{\"inputs\": {}}]}"},"action_components":{"component_engine_hash":"def component_engine_hash():\n    parts = {\"python\": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}\n    for language, path in component_scripts().items():\n        parts[language] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None\n    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode(\"utf-8\")).hexdigest()","component_definitions":"def component_definitions():\n    steps = {\"type\": \"array\", \"items\": {\"type\": \"object\"}, \"maxItems\": 100, \"default\": []}\n    limit = {\"type\": \"integer\", \"minimum\": 1, \"maximum\": 1000, \"default\": 100}\n    specs = [\n        (\"constant\", \"Constant\", {\"value\": {}}, [\"value\"], {\"value\": {}}, [\"pure\"]),\n        (\"cast\", \"Cast\", {\"value\": {}, \"target_type\": {\"type\": \"string\", \"enum\": VALUE_TYPES, \"default\": \"string\"}, \"trim\": {\"type\": \"boolean\", \"default\": False}}, [\"value\", \"target_type\"], {\"value\": {}}, [\"pure\"]),\n        (\"lookup\", \"Dictionary Lookup\", {\"dictionary\": {\"type\": \"object\", \"default\": {}}, \"key\": {\"type\": \"string\"}, \"default\": {}}, [\"dictionary\", \"key\"], {\"value\": {}}, [\"pure\"]),\n        (\"file-path\", \"File Path\", {\"path\": {\"type\": \"string\"}, \"must_exist\": {\"type\": \"boolean\", \"default\": False}}, [\"path\"], {\"path\": {\"type\": \"string\"}}, [\"local-read\"]),\n        (\"sleep\", \"Sleep\", {\"seconds\": {\"type\": \"number\", \"minimum\": 0, \"maximum\": 300, \"default\": 1}}, [\"seconds\"], {\"seconds\": {\"type\": \"number\"}}, [\"pure\"]),\n        (\"poll\", \"Poll until / timeout\", {\"body\": steps, \"condition\": {}, \"value\": {},\n            \"interval_seconds\": {\"type\": \"number\", \"exclusiveMinimum\": 0, \"maximum\": 300},\n            \"timeout_seconds\": {\"type\": \"number\", \"exclusiveMinimum\": 0, \"maximum\": 604800},\n            \"max_iterations\": limit}, [\"body\", \"condition\", \"value\", \"interval_seconds\", \"timeout_seconds\", \"max_iterations\"],\n            {\"status\": {\"enum\": [\"completed\", \"timed_out\"]}, \"attempts\": {\"type\": \"integer\"}, \"value\": {}}, [\"pure\"]),\n        (\"monitor\", \"Observe remote task\", {\"body\": steps, \"condition\": {}, \"value\": {},\n            \"remote_id\": {\"type\": \"string\", \"default\": \"\"},\n            \"interval_seconds\": {\"type\": \"number\", \"exclusiveMinimum\": 0, \"maximum\": 300},\n            \"timeout_seconds\": {\"type\": \"number\", \"exclusiveMinimum\": 0, \"maximum\": 604800},\n            \"max_iterations\": limit}, [\"body\", \"condition\", \"value\", \"interval_seconds\", \"timeout_seconds\", \"max_iterations\"],\n            monitor_schema()[\"properties\"], [\"pure\"]),\n        (\"if-else\", \"If / Else\", {\"condition\": {}, \"then_steps\": steps, \"else_steps\": steps, \"then_value\": {}, \"else_value\": {}}, [\"condition\", \"then_value\", \"else_value\"], {\"value\": {}}, [\"pure\"]),\n        (\"switch\", \"Switch\", {\"selector\": {}, \"cases\": {\"type\": \"array\", \"items\": {\"type\": \"object\"}, \"default\": [], \"maxItems\": 100}, \"default_steps\": steps, \"default_value\": {}}, [\"selector\", \"cases\", \"default_value\"], {\"value\": {}}, [\"pure\"]),\n        (\"math-expression\", \"Math Expression\", {\"expression\": {\"type\": \"string\", \"minLength\": 1, \"maxLength\": 1024, \"default\": MATH_EXAMPLE},\n            **{\"input_\" + str(index): {\"type\": \"number\"} for index in range(32)}}, [\"expression\"], {\"value\": {\"type\": \"number\"}}, [\"pure\"]),\n        (\"for\", \"For\", {\"items\": {\"type\": \"array\", \"maxItems\": 1000, \"default\": []}, \"body\": steps, \"value\": {}, \"max_iterations\": limit}, [\"items\", \"body\", \"value\", \"max_iterations\"], {\"values\": {\"type\": \"array\"}}, [\"pure\"]),\n        (\"while\", \"While\", {\"condition\": {}, \"body\": steps, \"value\": {}, \"max_iterations\": limit}, [\"condition\", \"body\", \"value\", \"max_iterations\"], {\"value\": {}}, [\"pure\"]),\n        (\"user-action\", \"User Choice\", {\"prompt\": {\"type\": \"string\", \"minLength\": 1, \"maxLength\": 500},\n            \"options\": {\"type\": \"array\", \"minItems\": 1, \"maxItems\": 24, \"items\": {\"type\": \"object\", \"properties\": {\"label\": {\"type\": \"string\", \"minLength\": 1, \"maxLength\": 120}, \"value\": {}}, \"required\": [\"label\", \"value\"], \"additionalProperties\": False}},\n            \"test_choice\": {\"type\": \"integer\", \"minimum\": 0, \"maximum\": 23, \"default\": 0}}, [\"prompt\", \"options\", \"test_choice\"], {\"value\": {}}, [\"human-input\"]),\n        (\"checkpoint\", \"Human Checkpoint\", {\n            \"kind\": {\"type\": \"string\", \"enum\": [\"input\", \"approval\", \"artifact-review\", \"decision\", \"exception\"], \"default\": \"approval\"},\n            \"proposal\": {}, \"evidence\": {\"type\": \"array\", \"default\": []},\n            \"owner\": {\"type\": \"string\", \"minLength\": 1, \"default\": \"user\"},\n            \"deadline\": {\"type\": [\"number\", \"null\"], \"default\": None},\n            \"timeout_behavior\": {\"type\": \"string\", \"enum\": [\"review\", \"cancel\"], \"default\": \"review\"},\n            \"answer_schema\": {\"type\": \"object\", \"default\": {\"type\": \"object\"}},\n            \"test_answer\": {\"type\": \"object\", \"default\": {}}},\n            [\"kind\", \"proposal\"], {\"value\": {}}, [\"human-input\"]),\n        (\"wait\", \"Durable Wait\", {\"trigger\": {\"type\": \"object\"},\n            \"deadline\": {\"type\": [\"number\", \"null\"], \"default\": None},\n            \"timeout_behavior\": {\"type\": \"string\", \"enum\": [\"review\", \"cancel\"], \"default\": \"review\"}},\n            [\"trigger\"], {\"value\": {}}, [\"pure\"]),\n    ]\n    return {\"core.\" + name: {\"action_id\": \"core.\" + name, \"display_name\": label, \"description\": label,\n            \"category\": \"core/\" + (\"logic\" if name in {\"if-else\", \"switch\", \"for\", \"while\"} else\n                \"interaction\" if name in {\"user-action\", \"checkpoint\"} else\n                \"timing\" if name in {\"sleep\", \"wait\", \"poll\", \"monitor\"} else\n                \"filesystem\" if name == \"file-path\" else \"values\"),\n            \"component\": True, \"version\": 1, \"effects\": effects,\n            \"component_implementations\": [{\"id\": language, \"language\": COMPONENT_LANGUAGES[language], \"default\": language == \"python\"}\n                                          for language in (COMPONENT_LANGUAGES if \"core.\" + name in STATELESS_COMPONENTS else [\"python\"])],\n            **({\"math_functions\": MATH_SOURCES, \"examples\": [{\"inputs\": {\"expression\": MATH_EXAMPLE, \"input_0\": 2, \"input_1\": 3, \"input_2\": 4, \"input_3\": math.e}, \"output\": {\"value\": 10.0}}]} if name == \"math-expression\" else {}),\n            \"input_schema\": {\"type\": \"object\", \"properties\": properties, \"required\": required, \"additionalProperties\": False},\n            \"output_schema\": {\"type\": \"object\", \"properties\": outputs, \"required\": list(outputs), \"additionalProperties\": False}}\n            for name, label, properties, required, outputs, effects in specs}","referenced_actions":"def referenced_actions(steps, depth=0):\n    if not isinstance(steps, list) or depth > 12:\n        raise ValueError(\"Invalid or excessive component nesting.\")\n    result = set()\n    for step in steps:\n        if not isinstance(step, dict):\n            raise ValueError(\"Each body step must be an object.\")\n        if \"action_id\" in step:\n            result.add(step[\"action_id\"])\n            continue\n        inputs = step.get(\"inputs\", {})\n        if not isinstance(inputs, dict):\n            raise ValueError(\"Step inputs must be an object.\")\n        for field in [\"then_steps\", \"else_steps\", \"default_steps\", \"body\"]:\n            if field in inputs:\n                result.update(referenced_actions(inputs[field], depth + 1))\n        if \"cases\" in inputs:\n            if not isinstance(inputs[\"cases\"], list):\n                raise ValueError(\"Switch cases must be a list.\")\n            for case in inputs[\"cases\"]:\n                if not isinstance(case, dict):\n                    raise ValueError(\"Switch cases must be objects.\")\n                result.update(referenced_actions(case.get(\"steps\", []), depth + 1))\n    return result","validate_steps":"def validate_steps(steps, dependencies, depth=0, budget=None):\n    budget = [0] if budget is None else budget\n    if not isinstance(steps, list) or depth > 12:\n        raise ValueError(\"Basic component body must be a list with nesting depth at most 12.\")\n    identifiers = set()\n    effects = set()\n    for step in steps:\n        budget[0] += 1\n        if budget[0] > 500 or not isinstance(step, dict) or set(step) - {\"id\", \"action_id\", \"content_hash\", \"component\", \"implementation\", \"inputs\", \"output_schema\"}:\n            raise ValueError(\"Invalid component step or structural budget exceeded.\")\n        identifier = step.get(\"id\")\n        if not isinstance(identifier, str) or not re.fullmatch(r\"[a-z][a-z0-9_-]{0,63}\", identifier) or identifier in identifiers:\n            raise ValueError(\"Invalid or duplicate component step ID.\")\n        identifiers.add(identifier)\n        if \"output_schema\" in step:\n            Draft202012Validator.check_schema(step[\"output_schema\"])\n        if (\"action_id\" in step) == (\"component\" in step) or not isinstance(step.get(\"inputs\"), dict):\n            raise ValueError(\"Each step must declare exactly one Action or basic component and its inputs.\")\n        if \"action_id\" in step:\n            if step[\"action_id\"] not in dependencies or step.get(\"content_hash\", dependencies.get(step[\"action_id\"])) != dependencies[step[\"action_id\"]]:\n                raise ValueError(\"Body Action is not declared and pinned: \" + step[\"action_id\"])\n            continue\n        definition = component_definitions().get(step[\"component\"])\n        if not definition:\n            raise ValueError(\"Unknown basic component.\")\n        if \"implementation\" in step and step[\"implementation\"] not in {item[\"id\"] for item in definition[\"component_implementations\"]}:\n            raise ValueError(\"Unsupported implementation for \" + step[\"component\"] + \": \" + str(step[\"implementation\"])\n                             + \". Python, JavaScript and TypeScript are available for stateless components; control-flow components run in the host.\")\n        inputs = step[\"inputs\"]\n        if set(inputs) - set(definition[\"input_schema\"][\"properties\"]) or set(definition[\"input_schema\"][\"required\"]) - set(inputs):\n            raise ValueError(\"Missing or unknown basic component inputs: \" + identifier)\n        effects.update(definition[\"effects\"])\n        if step[\"component\"] == \"core.sleep\" and not isinstance(inputs[\"seconds\"], dict):\n            seconds = inputs[\"seconds\"]\n            if type(seconds) not in {int, float} or not 0 <= seconds <= 300:\n                raise ValueError(\"Sleep seconds must be a finite number between 0 and 300.\")\n        if step[\"component\"] in {\"core.for\", \"core.while\", \"core.poll\", \"core.monitor\"}:\n            limit = inputs[\"max_iterations\"]\n            if type(limit) is not int or not 1 <= limit <= 1000:\n                raise ValueError(\"Loops require an explicit integer max_iterations between 1 and 1000.\")\n        for field in [\"then_steps\", \"else_steps\", \"default_steps\", \"body\"]:\n            if field in inputs:\n                effects.update(validate_steps(inputs[field], dependencies, depth + 1, budget))\n        if \"cases\" in inputs:\n            cases = inputs[\"cases\"]\n            if not isinstance(cases, list) or len(cases) > 100:\n                raise ValueError(\"Switch requires at most 100 cases.\")\n            matches = set()\n            for case in cases:\n                if not isinstance(case, dict) or set(case) - {\"match\", \"steps\", \"value\"} or not {\"match\", \"value\"}.issubset(case):\n                    raise ValueError(\"Switch cases require explicit match and value.\")\n                marker = json.dumps(case[\"match\"], sort_keys=True, allow_nan=False)\n                if marker in matches:\n                    raise ValueError(\"Duplicate switch case.\")\n                matches.add(marker)\n                effects.update(validate_steps(case.get(\"steps\", []), dependencies, depth + 1, budget))\n    return effects"},"action_recovery":{"validate_reconciler":"def validate_reconciler(value):\n    if not isinstance(value, dict) or value.get(\"kind\") not in RECONCILER_REGISTRY:\n        raise ValueError(\"Reconciler must declare a supported registry kind.\")\n    if value[\"kind\"] == \"file-hash\":\n        path = Path(value.get(\"path\", \"\"))\n        digest = value.get(\"sha256\")\n        if (not str(value.get(\"path\", \"\")) or path.is_absolute() or \"..\" in path.parts\n                or not isinstance(digest, str) or len(digest) != 64\n                or any(char not in \"0123456789abcdef\" for char in digest) or \"output\" not in value):\n            raise ValueError(\"File reconciler requires a relative workspace path, pinned SHA-256 and typed output.\")\n    elif value[\"kind\"] in {\"remote-resource\", \"message-order\"}:\n        if (not isinstance(value.get(\"lookup_action_id\"), str) or not isinstance(value.get(\"lookup_revision\"), str)\n                or not isinstance(value.get(\"inputs\"), dict) or not isinstance(value.get(\"success_field\"), str)\n                or \"success_value\" not in value or \"output\" not in value):\n            raise ValueError(\"Remote reconciler requires a pinned read-only lookup Action and exact success predicate/output.\")\n    return value"}};
export const originalActionCompilerRegression = {"test-action-authoring.py":{"test_schema_and_nonmutating_preflight":"def test_schema_and_nonmutating_preflight(self):\n        Draft202012Validator.check_schema(definition_schema())\n        before = self.snapshot()\n        with patch.object(self.runtime, \"call\", side_effect=AssertionError(\"must not execute\")):\n            for value in authoring_contract()[\"examples\"].values():\n                Draft202012Validator(definition_schema()).validate(value)\n                result = self.runtime.definition_check(value)\n                self.assertTrue(result[\"ok\"], result)\n                self.assertFalse(result[\"persisted\"])\n                self.assertFalse(result[\"executed\"])\n                self.assertFalse(result[\"readiness_checked\"])\n        self.assertEqual(self.snapshot(), before)","test_invalid_kinds_fields_platforms_and_schemas_have_paths":"def test_invalid_kinds_fields_platforms_and_schemas_have_paths(self):\n        mutations = [\n            (lambda value: value[\"implementations\"][0].update(kind=\"command\"),\n             \"/implementations/0/kind\", [\"program\", \"pipeline\", \"mcp\"]),\n            (lambda value: value[\"implementations\"][0].update(kind=\"python\"),\n             \"/implementations/0/kind\", [\"program\", \"pipeline\", \"mcp\"]),\n            (lambda value: value[\"implementations\"][0].pop(\"program\"),\n             \"/implementations/0/program\", None),\n            (lambda value: value[\"implementations\"][0].update(platforms=[\"linux\"]),\n             \"/implementations/0/platforms/0\", [\"Linux\", \"Windows\", \"Darwin\"]),\n            (lambda value: value[\"implementations\"][0].update(args=\"python -c ...\"),\n             \"/implementations/0/args\", None),\n            (lambda value: value[\"input_schema\"].update(type=\"bogus\"),\n             \"/input_schema/type\", None),\n        ]\n        before = self.snapshot()\n        for mutate, path, allowed in mutations:\n            with self.subTest(path=path, allowed=allowed):\n                value = copy.deepcopy(self.example)\n                mutate(value)\n                result = self.runtime.definition_check(value)\n                self.assertFalse(result[\"ok\"])\n                matches = [item for item in result[\"diagnostics\"] if item[\"path\"].startswith(path)]\n                self.assertTrue(matches, result)\n                if allowed:\n                    self.assertEqual(matches[0][\"allowed_values\"], allowed)\n                with self.assertRaises(ValueError):\n                    self.runtime.register(value)\n        self.assertEqual(self.snapshot(), before)","test_semantic_errors_and_existing_version_are_not_persisted":"def test_semantic_errors_and_existing_version_are_not_persisted(self):\n        self.runtime.register(self.example)\n        before = self.snapshot()\n        result = self.runtime.definition_check(self.example)\n        self.assertEqual(result[\"diagnostics\"][0][\"path\"], \"/version\")\n        invalid = copy.deepcopy(self.example)\n        invalid[\"action_id\"] = \"core.delay\"\n        self.assertFalse(self.runtime.definition_check(invalid)[\"ok\"])\n        invalid[\"action_id\"] = \"example.missing-dependency\"\n        invalid[\"dependencies\"] = {\"fixture.not.registered\": \"0\" * 64}\n        self.assertFalse(self.runtime.definition_check(invalid)[\"ok\"])\n        invalid[\"dependencies\"] = {}\n        invalid[\"implementations\"] = [{\"kind\": \"pipeline\", \"platforms\": [\"Linux\"],\n                                       \"steps\": [{\"id\": \"invalid\", \"component\": \"missing\", \"inputs\": {}}]}]\n        self.assertFalse(self.runtime.definition_check(invalid)[\"ok\"])\n        self.assertEqual(self.snapshot(), before)"},"test-action-modules.py":{"test_numbered_math_ports_in_executable_graph":"def test_numbered_math_ports_in_executable_graph(self):\n        with tempfile.TemporaryDirectory() as directory:\n            runtime = ModuleRuntime(Path(directory) / \"store\")\n            runtime.configure_workspace(directory)\n            components = {item[\"action_id\"]: item for item in runtime.components()}\n            example = components[\"core.math-expression\"][\"examples\"][0]\n            graph = {\"action_id\": \"test.math.expression\", \"nodes\": [\n                {\"id\": \"number\", \"action_id\": \"core.constant\", \"value_type\": \"number\",\n                 \"content_hash\": components[\"core.constant\"][\"content_hash\"], \"parameters\": {\"value\": 5}},\n                {\"id\": \"math\", \"action_id\": \"core.math-expression\",\n                 \"content_hash\": components[\"core.math-expression\"][\"content_hash\"], \"parameters\": example[\"inputs\"]}],\n                \"edges\": [{\"source\": \"number\", \"output\": \"value\", \"target\": \"math\", \"input\": \"input_0\"}], \"output_node\": \"math\"}\n            definition = runtime.graph_save(graph)\n            self.assertTrue(runtime.validate(definition[\"action_id\"], definition[\"content_hash\"])[\"ok\"])\n            run = runtime.call(definition[\"action_id\"], {}, \"math-wired\", definition[\"content_hash\"])\n            self.assertEqual(runtime.wait(run[\"run_id\"])[\"output\"], {\"value\": 19})\n            catalog = runtime.catalog()[\"actions\"]\n            self.assertFalse(any(item[\"action_id\"] == \"core.integer.add\" for item in catalog))\n            with self.assertRaises(FileNotFoundError):\n                runtime.definition(\"core.integer.add\")","test_module_set_export_import_selective_load_and_unload":"def test_module_set_export_import_selective_load_and_unload(self):\n        child = self.runtime.definition(\"test.fixture.add\")\n        definition = self.runtime.register({\"schema\": \"pkm.action.definition/v1\", \"action_id\": \"optional.math.add\", \"version\": 1,\n            \"description\": \"Optional addition\", \"effects\": [\"pure\"], \"input_schema\": child[\"input_schema\"], \"output_schema\": child[\"output_schema\"],\n            \"dependencies\": {child[\"action_id\"]: child[\"content_hash\"]}, \"implementations\": [{\"kind\": \"pipeline\", \"platforms\": [platform.system()],\n                \"steps\": [{\"id\": \"add\", \"action_id\": child[\"action_id\"], \"inputs\": {\"left\": {\"$input\": \"left\"}, \"right\": {\"$input\": \"right\"}}}],\n                \"output\": {\"sum\": {\"$step\": \"add.sum\"}}}], \"examples\": [{\"inputs\": {\"left\": 1, \"right\": 2}, \"output\": {\"sum\": 3}}]})\n        package = self.runtime.workspace() / \"math.pkm-actions\"\n        exported = self.runtime.module_set_export(\"optional.math\", 1, [definition[\"action_id\"]], str(package))\n        self.assertFalse(exported[\"host_state_exported\"])\n        target = ModuleRuntime(self.directory / \"imported\")\n        target.configure_workspace(str(self.runtime.workspace()))\n        self.assertFalse(target.module_set_import(str(package))[\"enabled\"])\n        self.assertNotIn(definition[\"action_id\"], {item[\"action_id\"] for item in target.list()})\n        target.module_set_load(\"optional.math\", 1)\n        imported = target.definition(definition[\"action_id\"])\n        self.assertEqual(imported[\"knowledgeId\"], definition[\"knowledgeId\"])\n        self.assertEqual(imported[\"content_hash\"], definition[\"content_hash\"])\n        self.assertNotEqual(target.availability(definition[\"action_id\"])[\"state\"], \"ready\")\n        target.module_set_load(\"optional.math\", 1, False)\n        self.assertNotIn(definition[\"action_id\"], {item[\"action_id\"] for item in target.list()})\n        self.assertEqual(len(target.module_set_list()[\"module_sets\"]), 1)\n        target.module_set_remove(\"optional.math\", 1)\n        self.assertEqual(target.module_set_list()[\"module_sets\"], [])"}};
