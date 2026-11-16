# Free-model aggregator

One server that makes OpenRouter's free models a single endpoint, on both
client wires. Point an OpenAI client at `POST /v1/chat/completions` or an
Anthropic client at `POST /v1/messages` — in JSON or in streaming — and every
answer is a real completion from a free model, dialled through the gateway
the trial provides. `GET /v1/models` answers in the shape of the caller's
auth header (`Authorization: Bearer` gets the OpenAI list, `x-api-key` the
Anthropic one).

## How it routes

The trial brief (`$MAKEFUN_PROMPT_FILE`) lists the free models with the
house's quality rating for each, and the prompts in the order they arrive.
For every prompt the server builds a ladder of the free models whose
capabilities meet the prompt's requirements (tools, vision, JSON mode,
context), ranked by rating, best first:

- the best model is dialled first, through the gateway's Chat Completions
  route, with the request translated from the client's wire;
- a refusal fails over to the next model on the ladder; a 5xx first earns
  its model one retry, and a 429 cools that model down for the rest of the
  trial so later prompts do not spend calls on a rate-limited model;
- refusals a prompt recovered from are reported on its answer in the
  `x-makefun-upstream-failures` header, in the order they happened;
- the answer returns in the client's own wire, with its `model` field
  naming the dialable id of the model that really answered.

Every choice is a function of the brief, the requests and the gateway's
answers: no wall clock and no randomness, so a replayed trial leaves the
same state.

## Running

Node 22, standard library only; nothing to install.

```
node main.ts --list   # print the catalog document this server registers
node main.ts          # serve a trial (env: MAKEFUN_ENV_URL,
                      # MAKEFUN_PROMPT_FILE, OPENAI_BASE_URL, OPENAI_API_KEY)
```

Started without `--list`, the server listens on a free port of its own,
registers that port and its catalog with the env at `$MAKEFUN_ENV_URL`,
serves until the env's `GET /work` reports the trial done, and exits 0.

## License

MIT — see `LICENSE`.
