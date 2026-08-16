# Nutrient Tracker Agent Guide

This document describes the agent architecture that actually exists in this
repository. Do not copy agent infrastructure from KookarCore or another Nutri
service unless the required modules are first implemented here.

## Current Agents

| Agent | Prompt | Purpose | Customer meal writes |
|---|---|---|---|
| `nutrition_chat` | `nutrition-chat-v1` | Conversational reads and explicitly gated mutations | Only through approved tools |
| `media_facts` | `media-facts-v1` | Extract factual image/PDF evidence and one authoritative quantity per item | Never |
| `media_meal_resolver` | `media-meal-resolver-v1` | Resolve or create global dish identities for a media review draft | Never |
| `manual_meal_resolver` | `manual-meal-resolver-v1` | Resolve or create a dish for an explicit manual meal submission | The caller writes after resolution |

Speech-to-text is a provider service, not an agent. It transcribes audio and
sends the plain transcript to `nutrition_chat`.

## Core Rules

1. Use `user_id`, not `house_id`. User IDs are Supabase Auth UUIDs.
2. Use `NutrientTrackerRuntimeContext` from
   `app.agents.runtime_context` for LangChain agents.
3. Keep checked-in prompt fallbacks. LangSmith must never be required for the
   application to run.
4. Keep system instructions and dynamic user input in separate message roles.
5. Use strict Pydantic contracts for structured input and output.
6. Models select or classify. Deterministic application code performs serving
   conversion, nutrition arithmetic, validation, and persistence.
7. Never let a media upload write a customer meal before explicit confirmation.
8. Trace sanitized structured input and output. Never trace secrets, bearer
   tokens, raw image bytes, or base64 media.
9. Agent code does not issue raw SQL. Use domain repositories and services.
10. Every model-selected ID must be validated against the IDs supplied to that
    model before it is applied.

## Repository Structure

Use this folder pattern. Include only files the agent needs.

```text
backend/app/agents/<agent_name>/
|-- __init__.py
|-- agent.py       # Model/agent construction and one model invocation
|-- prompt.py      # Prompt name and checked-in fallback text
|-- models.py      # Strict input/output contracts
|-- state.py       # LangGraph/LangChain state when needed
|-- middleware.py  # Agent-specific model, prompt, or context middleware
`-- runner.py      # Orchestration, validation, tracing, telemetry
```

Current examples:

- `nutrition_chat`: LangChain agent with tools, middleware, state, and runner.
- `manual_meal_resolver`: LangChain structured-output agent with prompt
  middleware and a runner that validates and applies catalog decisions.
- `media_facts`: LangGraph wrapper around one OpenAI structured-response call.
- `media_meal_resolver`: direct OpenAI structured-response agent plus a runner
  that loads catalog context and applies validated catalog decisions.

Do not introduce `@register_agent`, `agent_invoke_service`,
`nutriRuntimeContext`, or `nutriModelAndPromptMiddleware`. Those APIs are not
part of this repository.

## Runtime Context

The shared context for LangChain agents is:

```python
from app.agents.runtime_context import NutrientTrackerRuntimeContext

context = NutrientTrackerRuntimeContext(
    user_id=user_id,
    thread_id=thread_id,
)
```

Pass the same values in `config` when a LangChain agent or tool needs them:

```python
config = {
    "configurable": {
        "user_id": user_id,
        "thread_id": thread_id,
    }
}
```

Middleware should prefer `runtime.context`, then state, then
`runtime.config["configurable"]` when a fallback is necessary. Do not trust a
model-provided user ID.

## Agent Construction Patterns

### LangChain Agent With Tools

Use `create_agent` for conversational agents that need tools or middleware.
`nutrition_chat` is the reference implementation.

```python
from langchain.agents import create_agent
from langchain.agents.structured_output import AutoStrategy

agent = create_agent(
    model=resolve_model(),
    tools=available_tools,
    name="nutrition_chat",
    state_schema=NutritionChatState,
    context_schema=NutrientTrackerRuntimeContext,
    response_format=AutoStrategy(ChatTurn),
    middleware=[
        ModelAndPromptMiddleware(...),  # Prompt/model middleware is first.
        UserContextMiddleware(),
    ],
)
```

Requirements:

- Tool functions delegate to `app.domain.*` services.
- Mutation tools are excluded unless the runner has established explicit user
  intent.
- Numeric nutrition entry remains separately confirmation-gated.
- Middleware calls `super().__init__()`.
- Agents are invoked asynchronously with `ainvoke`.

### LangChain Structured Agent Without Tools

Use `ToolStrategy(Model)` when middleware-driven structured output is useful
but no tools should be available. `manual_meal_resolver` is the reference.

```python
agent = create_agent(
    model=resolve_manual_resolver_model(),
    tools=[],
    name="manual_meal_resolver",
    state_schema=ManualMealResolverState,
    context_schema=NutrientTrackerRuntimeContext,
    response_format=ToolStrategy(ManualResolution),
    middleware=[ManualResolverPromptMiddleware()],
)
```

Read the result from `result["structured_response"]` and validate it before
performing any database operation.

### Direct OpenAI Structured Response

Use one `AsyncOpenAI.responses.parse` call when an agent has no tool loop and a
single strict decision is clearer than a general LangChain graph.

```python
response = await client.responses.parse(
    model=settings.MEDIA_MEAL_RESOLVER_MODEL,
    input=[
        {"role": "system", "content": resolved_prompt.text},
        {"role": "user", "content": serialized_dynamic_input},
    ],
    text_format=OutputModel,
)
```

The system message contains stable policy. The user message contains only
request-specific facts and allowlisted context.

## Strict Models

Structured models should reject unknown fields and non-finite numbers.

```python
from pydantic import BaseModel, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
```

Use validators for invariants, but keep provider output recoverable when safe.
For example, a malformed media `create_new` decision can become one provider
lookup and then `unresolved`; it must never become an invented reference.

Validation belongs in two layers:

1. Pydantic validates shape and field constraints.
2. The runner validates selected IDs, categories, and reference IDs against the
   supplied allowlists.

## Prompt Management

Every runtime prompt has:

- A unique `*-v1` name in `prompt.py`.
- A checked-in fallback string.
- A corresponding entry in `backend/scripts/publish_prompts.py`.

Runtime resolution:

```python
from app.services.prompts import resolve_prompt

prompt = await resolve_prompt(PROMPT_NAME, FALLBACK_PROMPT)
```

`resolve_prompt`:

- Pulls from LangSmith when configured.
- Caches successful pulls for 60 seconds.
- Falls back to checked-in text on any registry failure.
- Returns prompt source and version metadata.

Publish all prompts:

```bash
cd backend
uv run python -m scripts.publish_prompts
```

After changing a prompt:

1. Run prompt unit tests.
2. Publish it.
3. Clear the local prompt cache before live verification.
4. Verify the pulled text exactly equals the checked-in fallback.
5. Remove obsolete prompt repositories when replacing a prompt name.

Do not interpolate dynamic input into the system prompt. For JSON examples in
LangChain `PromptTemplate` strings, escape literal braces. The publisher
already handles literal braces for plain fallback prompts.

## Tracing And Telemetry

Use `trace_agent` around the complete logical agent execution:

```python
from app.services.prompts import trace_agent

with trace_agent(
    "media_meal_resolver",
    metadata={"item_count": len(facts.items)},
    inputs={"resolver_input": resolver_input.model_dump(mode="json")},
) as run:
    plan = await invoke_model()
    if run is not None:
        run.add_outputs({"plan": plan.model_dump(mode="json")})
```

Tracing rules:

- Inputs and outputs must be populated, including failed structured plans when
  available.
- For media, trace MIME type, filename, byte count, optional note, and parsed
  facts. Do not trace raw bytes or base64.
- Include prompt name, prompt source, and prompt version in outputs.
- Record one `agent_runs` row through `app.domain.messages.repository` with
  duration, model, token usage, status, and safe output metadata.
- Telemetry failure must not fail the user operation.

## Media Pipeline Contract

The media flow has two separate agents.

```text
image/PDF
  -> media_facts
  -> media_meal_resolver
  -> deterministic serving/nutrition draft
  -> needs_confirmation
  -> user confirms
  -> customer meal rows
```

### Agent 1: `media_facts`

Responsibilities:

- Split clearly separable foods into separate items.
- Return one authoritative quantity for every item.
- Always provide `total_grams`.
- Include uncertainty range, source, confidence, and basis.
- Preserve PDF date and meal slot when present.
- Never output a food ID, category selection, servings, or calculated
  nutrition.

For a burger, fries, and sauce cup, three items are required. A combined
`"burger with fries"` item is invalid.

### Agent 2: `media_meal_resolver`

Inputs:

- Exact `media_facts` output.
- Complete active global dish identities and aliases.
- Active categories.
- The user's merged category portions.
- An application-generated timestamped fallback name for each evidence item.

Capabilities:

- Match an existing global dish.
- Create a global dish through the audited resolver tool when the supplied catalog has no match.
- Return a structured decision for every evidence item.
- Create an unnamed item in the fixed one-gram `unknown` category rather than leaving it unresolved.

Prohibitions:

- No customer meal insert, update, or delete dependency.
- No quantity replacement or re-estimation.
- No serving or nutrient arithmetic in model output.
- No invented dish, category, or provider IDs.

After identity resolution, deterministic code computes:

```text
servings = Agent 1 total_grams / fixed grams per serving
nutrition = database nutrients_per_unit * servings
```

The user's usual household serving count never replaces Agent 1 quantity.

### Confirmation Boundary

Every supported image or PDF upload means "prepare a draft", not "log this meal".
It always runs through `media_facts` and then `media_meal_resolver`; nutrition chat
is a separate flow and is never part of media processing.

- The message is persisted as `needs_confirmation`.
- The UI may edit servings, date, meal slot, or remove an item.
- Dish identity, serving unit, and grams per serving are read-only.
- The confirmation endpoint ignores client-supplied grams and recomputes grams
  from stored fixed serving grams and edited servings.
- Only `POST /messages/{id}/confirm` writes customer meal rows.
- Discarding a draft writes no customer meal.

Global catalog creation is allowed during Agent 2 resolution. That is not a
customer meal write.

## Manual Meal Resolver Contract

Manual submission is a separate use case:

```text
typed dish name + explicit servings
  -> manual_meal_resolver
  -> match/create global dish
  -> caller writes customer meal immediately
```

The manual agent receives the serving count from the user. It does not estimate
quantity from media. The surrounding meal service may write immediately because
pressing the manual add button is explicit logging intent.

Do not merge the manual and media agents. They may share repositories, provider
search, catalog creation, and validation patterns, but their prompts, inputs,
outputs, and persistence boundaries differ.

## Database And Side-Effect Boundaries

- FastAPI is the only application layer that accesses Supabase product data.
- Agents call domain repositories/services; frontends never call Supabase
  product tables.
- `media_meal_resolver` may import dish and message repositories, but must not
  import `app.domain.meals`.
- `manual_meal_resolver` returns a resolved dish; `app.domain.meals.service`
  performs the explicit manual meal write.
- Global dish creation uses `dish_repo.create_global_dish`, which calls the
  audited, idempotent `fn_create_global_dish` RPC.
- Provider nutrition remains server-side. The model selects only a supplied
  reference ID.

## Error Handling

- Unsupported media and byte limits are validated before provider calls.
- If Agent 1 cannot produce usable facts, return a readable failed message.
- If Agent 2 cannot match or create every item, return no completed draft.
- Provider failure must remain unresolved; never invent nutrition.
- Persist failed agent telemetry where possible.
- Do not expose provider exceptions, secrets, or internal IDs in user-facing
  messages.

## Testing

Focused agent tests live under `backend/tests/unit/`:

- `test_media_facts_agent.py`
- `test_media_meal_resolver.py`
- `test_media_meal_draft.py`
- `test_manual_meal_resolver.py`
- `test_message_agent_flow.py`
- `test_prompts.py`

Minimum tests for a new or changed agent:

1. System and dynamic user input remain separate roles.
2. Structured models reject forbidden fields and invalid numbers.
3. Selected IDs are allowlisted.
4. Provider-backed creation uses server-held nutrients.
5. Failure does not cross the persistence boundary.
6. Traces contain sanitized inputs and structured outputs.
7. Prompt fallback and LangSmith pull behavior both work.
8. The relevant route flow is covered without invoking unrelated agents.

Run backend verification:

```bash
cd backend
uv run ruff check .
uv run pytest tests/unit -q
uv run lint-imports
```

Run the required database suite against pgvector/Postgres before completing a
change that touches persistence or migrations:

```bash
NT_REQUIRE_DATABASE=1 NT_FAIL_ON_SKIP=1 uv run pytest -q
```

Run customer verification when a draft contract or review UI changes:

```bash
cd customer-app
npm run typecheck
npm test
npm run build
```

Live acceptance for media changes must use:

- A real supported image or PDF.
- Real OpenAI calls.
- A real authenticated hosted user or disposable hosted user.
- LangSmith traces with populated input and output.
- A meal-row count check proving upload alone writes no customer meal.
- A confirmation check proving servings determine server-side grams.

Unit-test mocks remain useful, but they do not replace the live acceptance run.

## New Agent Checklist

- [ ] Define one responsibility and explicit side-effect boundary.
- [ ] Create `backend/app/agents/<agent_name>/`.
- [ ] Add strict input/output models.
- [ ] Add a checked-in fallback prompt and unique prompt name.
- [ ] Keep system and user messages separate.
- [ ] Use `NutrientTrackerRuntimeContext` when context is needed.
- [ ] Add a runner for orchestration, validation, tracing, and telemetry.
- [ ] Validate every model-selected ID against supplied context.
- [ ] Add the prompt to `scripts/publish_prompts.py`.
- [ ] Add focused unit tests.
- [ ] Run Ruff, unit tests, import contracts, and relevant frontend checks.
- [ ] Publish and verify the LangSmith prompt.
- [ ] Perform a real-provider acceptance run when the agent calls an external
      model or provider.

No evaluator enum, Redis inbox, global agent registry, or provider decorator is
required by this repository.
