/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/group_pay.json`.
 */
export type GroupPay = {
  "address": "6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R",
  "metadata": {
    "name": "groupPay",
    "version": "0.2.0",
    "spec": "0.1.0",
    "description": "Create and join skeleton for the local-only group payment prototype"
  },
  "instructions": [
    {
      "name": "cancelEvent",
      "discriminator": [
        55,
        143,
        36,
        45,
        59,
        241,
        89,
        119
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "vault",
          "relations": [
            "event"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "claimRefund",
      "discriminator": [
        15,
        16,
        30,
        161,
        255,
        228,
        97,
        60
      ],
      "accounts": [
        {
          "name": "participant",
          "signer": true,
          "relations": [
            "participation"
          ]
        },
        {
          "name": "mint",
          "address": "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true,
          "relations": [
            "participation"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "participation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  114,
                  116,
                  105,
                  99,
                  105,
                  112,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "participant"
              }
            ]
          }
        },
        {
          "name": "participantTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "createEvent",
      "discriminator": [
        49,
        219,
        29,
        203,
        22,
        98,
        100,
        87
      ],
      "accounts": [
        {
          "name": "organizer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint",
          "address": "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj"
        },
        {
          "name": "organizerTokenAccount"
        },
        {
          "name": "event",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "organizer"
              },
              {
                "kind": "arg",
                "path": "args.eventId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createEventArgs"
            }
          }
        }
      ]
    },
    {
      "name": "finalizeFailedOrEmpty",
      "discriminator": [
        215,
        39,
        38,
        130,
        42,
        145,
        88,
        244
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "vault",
          "relations": [
            "event"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "joinEvent",
      "discriminator": [
        10,
        93,
        234,
        137,
        237,
        194,
        224,
        0
      ],
      "accounts": [
        {
          "name": "participant",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint",
          "address": "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
          "relations": [
            "event"
          ]
        },
        {
          "name": "participantTokenAccount",
          "writable": true
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "participation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  114,
                  116,
                  105,
                  99,
                  105,
                  112,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "account",
                "path": "participant"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "settleEvent",
      "discriminator": [
        43,
        34,
        6,
        191,
        246,
        190,
        163,
        128
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "mint",
          "address": "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "organizerTokenAccount",
          "writable": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "updatePayoutAccount",
      "discriminator": [
        221,
        189,
        116,
        209,
        218,
        231,
        187,
        158
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true
        },
        {
          "name": "newOrganizerTokenAccount"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "event",
      "discriminator": [
        125,
        192,
        125,
        158,
        9,
        115,
        152,
        233
      ]
    },
    {
      "name": "participation",
      "discriminator": [
        237,
        154,
        142,
        46,
        143,
        63,
        189,
        18
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "wrongMint",
      "msg": "The supplied mint is not the fixed worthless test mint"
    },
    {
      "code": 6001,
      "name": "wrongTokenAccountMint",
      "msg": "The token account uses a different mint"
    },
    {
      "code": 6002,
      "name": "wrongTokenAccountOwner",
      "msg": "The token account is not owned by the expected signer"
    },
    {
      "code": 6003,
      "name": "wrongVaultAuthority",
      "msg": "The vault authority is not the event PDA"
    },
    {
      "code": 6004,
      "name": "eventNotOpen",
      "msg": "The event is not open"
    },
    {
      "code": 6005,
      "name": "registrationClosed",
      "msg": "Registration is closed; joining requires now < deadline"
    },
    {
      "code": 6006,
      "name": "eventFull",
      "msg": "The event has no remaining seats"
    },
    {
      "code": 6007,
      "name": "emptyTitle",
      "msg": "The title is required"
    },
    {
      "code": 6008,
      "name": "emptyDescription",
      "msg": "The description is required"
    },
    {
      "code": 6009,
      "name": "emptyVenue",
      "msg": "The venue or online method is required"
    },
    {
      "code": 6010,
      "name": "titleTooLong",
      "msg": "The UTF-8 title exceeds 64 bytes"
    },
    {
      "code": 6011,
      "name": "descriptionTooLong",
      "msg": "The UTF-8 description exceeds 280 bytes"
    },
    {
      "code": 6012,
      "name": "venueTooLong",
      "msg": "The UTF-8 venue exceeds 160 bytes"
    },
    {
      "code": 6013,
      "name": "timeZoneTooLong",
      "msg": "The IANA time zone identifier exceeds 64 UTF-8 bytes"
    },
    {
      "code": 6014,
      "name": "unsupportedTimeZone",
      "msg": "The IANA time zone is not supported by this version"
    },
    {
      "code": 6015,
      "name": "invalidPrice",
      "msg": "The unit price must be greater than zero"
    },
    {
      "code": 6016,
      "name": "invalidMinimum",
      "msg": "The minimum number of wallets must be at least two"
    },
    {
      "code": 6017,
      "name": "invalidCapacity",
      "msg": "Capacity must be between the minimum and 100"
    },
    {
      "code": 6018,
      "name": "deadlineTooSoon",
      "msg": "The registration deadline must be at least 30 minutes away"
    },
    {
      "code": 6019,
      "name": "deadlineTooFar",
      "msg": "The registration deadline cannot be more than 90 days away"
    },
    {
      "code": 6020,
      "name": "eventNotAfterDeadline",
      "msg": "The event start must be later than the registration deadline"
    },
    {
      "code": 6021,
      "name": "vaultBelowObligation",
      "msg": "The actual vault balance is below the legal funding obligation"
    },
    {
      "code": 6022,
      "name": "arithmeticOverflow",
      "msg": "Checked arithmetic overflow"
    },
    {
      "code": 6023,
      "name": "cancellationClosed",
      "msg": "Cancellation requires OPEN and now < deadline"
    },
    {
      "code": 6024,
      "name": "deadlineNotReached",
      "msg": "The deadline has not been reached"
    },
    {
      "code": 6025,
      "name": "thresholdMet",
      "msg": "The event has already met its minimum"
    },
    {
      "code": 6026,
      "name": "thresholdNotMet",
      "msg": "The event has not met its minimum"
    },
    {
      "code": 6027,
      "name": "eventNotSettleable",
      "msg": "The event cannot be settled in its current state"
    },
    {
      "code": 6028,
      "name": "refundNotAvailable",
      "msg": "Refunds are unavailable in the current state"
    },
    {
      "code": 6029,
      "name": "alreadyRefunded",
      "msg": "This participation has already been refunded"
    },
    {
      "code": 6030,
      "name": "refundCountExceeded",
      "msg": "Refund count exceeds the number of participants"
    },
    {
      "code": 6031,
      "name": "payoutUpdateClosed",
      "msg": "The payout account can only change in OPEN or READY"
    },
    {
      "code": 6032,
      "name": "payoutAccountUnchanged",
      "msg": "The payout account is unchanged"
    }
  ],
  "types": [
    {
      "name": "createEventArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "eventId",
            "type": "u64"
          },
          {
            "name": "title",
            "type": "string"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "fulfillmentMode",
            "type": {
              "defined": {
                "name": "fulfillmentMode"
              }
            }
          },
          {
            "name": "venue",
            "type": "string"
          },
          {
            "name": "timeZone",
            "type": "string"
          },
          {
            "name": "unitPrice",
            "type": "u64"
          },
          {
            "name": "minWallets",
            "type": "u16"
          },
          {
            "name": "capacity",
            "type": "u16"
          },
          {
            "name": "registrationDeadline",
            "type": "i64"
          },
          {
            "name": "eventStart",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "emptyCloseReason",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "notClosed"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "deadline"
          }
        ]
      }
    },
    {
      "name": "event",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "eventId",
            "type": "u64"
          },
          {
            "name": "organizer",
            "type": "pubkey"
          },
          {
            "name": "organizerTokenAccount",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "title",
            "type": "string"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "fulfillmentMode",
            "type": {
              "defined": {
                "name": "fulfillmentMode"
              }
            }
          },
          {
            "name": "venue",
            "type": "string"
          },
          {
            "name": "timeZone",
            "type": "string"
          },
          {
            "name": "unitPrice",
            "type": "u64"
          },
          {
            "name": "minWallets",
            "type": "u16"
          },
          {
            "name": "capacity",
            "type": "u16"
          },
          {
            "name": "registrationDeadline",
            "type": "i64"
          },
          {
            "name": "eventStart",
            "type": "i64"
          },
          {
            "name": "participantCount",
            "type": "u16"
          },
          {
            "name": "refundedCount",
            "type": "u16"
          },
          {
            "name": "expectedEscrow",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "eventStatus"
              }
            }
          },
          {
            "name": "emptyCloseReason",
            "type": {
              "defined": {
                "name": "emptyCloseReason"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "eventStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "ready"
          },
          {
            "name": "paid"
          },
          {
            "name": "refundingFailed"
          },
          {
            "name": "refundingCancelled"
          },
          {
            "name": "refunded"
          },
          {
            "name": "closedEmpty"
          }
        ]
      }
    },
    {
      "name": "fulfillmentMode",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "offline"
          },
          {
            "name": "online"
          }
        ]
      }
    },
    {
      "name": "participation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "participant",
            "type": "pubkey"
          },
          {
            "name": "paidAmount",
            "type": "u64"
          },
          {
            "name": "joinedAt",
            "type": "i64"
          },
          {
            "name": "refunded",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
