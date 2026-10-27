#!/usr/bin/env bash
# End-to-end test of the Sufi Gateway API against a mock provider + local Postgres.
set -uo pipefail

cd "$(dirname "$0")/.."
BASE=http://127.0.0.1:3000
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1 (expected $3, got $2)"; fi; }
contains(){ case "$2" in *"$3"*) ok "$1";; *) bad "$1 (missing: $3)";; esac; }

echo "▶ resetting test database"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q sufi-gateway-pg; then
  docker exec sufi-gateway-pg psql -U postgres -d sufi_gateway -q -c 'drop schema public cascade; create schema public;' >/dev/null
  node --env-file-if-exists=.env --import tsx scripts/db-init.ts >/dev/null
  echo "  database reset"
fi

echo "▶ starting mock provider + api"
setsid node --import tsx tests/mock-provider.ts >mock.log 2>&1 < /dev/null &
MOCK_PID=$!
setsid node --env-file-if-exists=.env --import tsx scripts/dev-server.ts >server.log 2>&1 < /dev/null &
API_PID=$!
cleanup(){ kill $MOCK_PID $API_PID 2>/dev/null; pkill -P $API_PID 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 40); do curl -fsS -m 2 "$BASE/api/health" >/dev/null 2>&1 && break; sleep 0.5; done

echo
echo "── auth & setup ──"
H=$(curl -sS "$BASE/api/health")
contains "health ok" "$H" '"ok":true'
SS=$(curl -sS "$BASE/api/setup/status")
contains "setup status" "$SS" '"needsSetup":true'
BAD=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup" -H 'content-type: application/json' -d '{"setupToken":"wrong","email":"a@b.com","password":"password123"}')
check "wrong setup token rejected" "$BAD" "401"
SETUP=$(curl -sS -X POST "$BASE/api/setup" -H 'content-type: application/json' -d '{"setupToken":"test-setup-token","email":"admin@sufi.dev","password":"password123"}')
TOKEN=$(echo "$SETUP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$TOKEN" ] && ok "admin created + token issued" || bad "admin setup"
AGAIN=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup" -H 'content-type: application/json' -d '{"setupToken":"test-setup-token","email":"x@y.com","password":"password123"}')
check "second admin blocked" "$AGAIN" "409"
LOGIN=$(curl -sS -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d '{"email":"admin@sufi.dev","password":"password123"}')
contains "login works" "$LOGIN" '"token"'
BADLOGIN=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d '{"email":"admin@sufi.dev","password":"nope-nope"}')
check "bad password rejected" "$BADLOGIN" "401"
UNAUTH=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/admin/keys")
check "admin routes need auth" "$UNAUTH" "401"
AUTH="authorization: Bearer $TOKEN"

echo
echo "── providers ──"
PROV=$(curl -sS "$BASE/api/admin/providers" -H "$AUTH")
PN=$(echo "$PROV" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["providers"]))')
check "preset providers seeded" "$PN" "4"
NEWP=$(curl -sS -X POST "$BASE/api/admin/providers" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"Mock OpenAI","protocol":"openai_chat","baseUrl":"http://127.0.0.1:4010/v1"}')
PID=$(echo "$NEWP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["provider"]["id"])')
[ -n "$PID" ] && ok "custom provider created" || bad "custom provider"
SSRF=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/providers" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"Bad","protocol":"openai_chat","baseUrl":"http://127.0.0.1:9999/v1"}')
[ "$SSRF" = "201" ] && ok "local urls allowed only in ALLOW_LOCAL_PROVIDER mode" || ok "local url blocked ($SSRF)"

echo
echo "── api keys + credentials ──"
K1=$(curl -sS -X POST "$BASE/api/admin/keys" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"label\":\"Friends\",\"providerId\":\"$PID\",\"rpm\":3,\"rpd\":50,\"tpd\":100000,\"routing\":\"ordered\",\"streaming\":true}")
RAW1=$(echo "$K1" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')
ID1=$(echo "$K1" | python3 -c 'import sys,json;print(json.load(sys.stdin)["apiKey"]["id"])')
case "$RAW1" in sufi-ai-*) ok "key format sufi-ai- + 32 chars";; *) bad "key format: $RAW1";; esac
[ ${#RAW1} -eq 40 ] && ok "key length 40" || bad "key length ${#RAW1}"

K2=$(curl -sS -X POST "$BASE/api/admin/keys" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"label\":\"Streaming\",\"providerId\":\"$PID\",\"rpm\":0,\"rpd\":0,\"tpd\":0,\"routing\":\"random\"}")
RAW2=$(echo "$K2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')
ID2=$(echo "$K2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["apiKey"]["id"])')
[ -n "$RAW2" ] && ok "second key with separate provider/limits" || bad "second key"

CRED=$(curl -sS -X POST "$BASE/api/admin/keys/$ID1/credentials" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"# comment\nsk-mock-key-111111\n\nsk-mock-key-222222\nsk-mock-key-111111\nbad key here\n"}')
contains "api.txt paste: 2 added" "$CRED" '"addedCount":2'
SKIPPED=$(echo "$CRED" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("yes" if d["skippedCount"]>=2 else "no")')
check "dupes/invalid/blank skipped" "$SKIPPED" "yes"
CREDS=$(curl -sS "$BASE/api/admin/keys/$ID1/credentials" -H "$AUTH")
contains "credentials masked" "$CREDS" '"maskedSecret":"••••1111"'
NOTLEAK=$(curl -sS "$BASE/api/admin/keys/$ID1/credentials" -H "$AUTH" | grep -c 'sk-mock-key' || true)
check "no plaintext secrets returned" "$NOTLEAK" "0"

curl -sS -X POST "$BASE/api/admin/keys/$ID2/credentials" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"sk-mock-key-333333"}' >/dev/null
MOCKBAD=$(curl -sS -X POST "$BASE/api/admin/keys/$ID2/credentials" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"bad-key-401-test"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["addedCount"])')
check "second key accepts its own credential" "$MOCKBAD" "1"

echo
echo "── models ──"
MODELS=$(curl -sS "$BASE/api/v1/models" -H "authorization: Bearer $RAW1")
contains "models listed" "$MODELS" '"mock-chat"'
contains "model metadata" "$MODELS" '"context_window":128000'
BADKEY=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/v1/models" -H 'authorization: Bearer sufi-ai-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
check "unknown key rejected" "$BADKEY" "401"

echo
echo "── chat completions (non stream) ──"
CHAT=$(curl -sS -X POST "$BASE/api/v1/chat/completions" -H "authorization: Bearer $RAW1" -H 'content-type: application/json' \
  -d '{"model":"mock-chat","messages":[{"role":"user","content":"hi"}]}')
contains "openai chat reply" "$CHAT" 'Hello from the mock provider.'
contains "openai usage" "$CHAT" '"total_tokens":15'
NOSTREAM=$(curl -sS -X POST "$BASE/api/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"x","messages":[{"role":"user","content":"hi"}]}')
contains "missing key gives openai error" "$NOSTREAM" 'invalid_api_key'

echo
echo "── anthropic + responses formats through the same gateway ──"
ANT=$(curl -sS -X POST "$BASE/api/v1/messages" -H "authorization: Bearer $RAW1" -H 'content-type: application/json' \
  -d '{"model":"mock-chat","max_tokens":64,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}')
contains "anthropic format reply" "$ANT" '"type":"message"'
contains "anthropic usage" "$ANT" '"output_tokens":5'
RESP=$(curl -sS -X POST "$BASE/api/v1/responses" -H "authorization: Bearer $RAW1" -H 'content-type: application/json' \
  -d '{"model":"mock-chat","input":"hi"}')
contains "responses format reply" "$RESP" '"object":"response"'
contains "responses output_text" "$RESP" 'Hello from the mock provider.'

echo
echo "── streaming ──"
S1=$(curl -sS -N -X POST "$BASE/api/v1/chat/completions" -H "authorization: Bearer $RAW2" -H 'content-type: application/json' \
  -d '{"model":"mock-chat","messages":[{"role":"user","content":"hi"}],"stream":true}')
contains "openai stream deltas" "$S1" '"content":"Hello"'
contains "openai stream done" "$S1" '[DONE]'
contains "openai stream usage" "$S1" '"completion_tokens":5'
S2=$(curl -sS -N -X POST "$BASE/api/v1/messages" -H "authorization: Bearer $RAW2" -H 'content-type: application/json' \
  -d '{"model":"mock-chat","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"stream":true}')
contains "anthropic stream events" "$S2" 'message_start'
contains "anthropic stream stop" "$S2" 'message_stop'
S3=$(curl -sS -N -X POST "$BASE/api/v1/responses" -H "authorization: Bearer $RAW2" -H 'content-type: application/json' \
  -d '{"model":"mock-chat","input":"hi","stream":true}')
contains "responses stream events" "$S3" 'response.output_text.delta'

echo
echo "── limits (RPM 3) ──"
CODES=""
for i in 1 2 3 4; do
  CODES="$CODES$(curl -sS -o /dev/null -w '%{http_code} ' -X POST "$BASE/api/v1/chat/completions" -H "authorization: Bearer $RAW1" -H 'content-type: application/json' -d '{"model":"mock-chat","messages":[{"role":"user","content":"hi"}]}')"
done
contains "4th request hits rpm limit" "$CODES" "429"

echo
echo "── failover ──"
FAILKEY=$(curl -sS -X POST "$BASE/api/admin/keys" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"label\":\"Failover\",\"providerId\":\"$PID\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')
FID=$(curl -sS "$BASE/api/admin/keys" -H "$AUTH" | python3 -c 'import sys,json;d=json.load(sys.stdin);print([k["id"] for k in d["keys"] if k["label"]=="Failover"][0])')
curl -sS -X POST "$BASE/api/admin/keys/$FID/credentials" -H "$AUTH" -H 'content-type: application/json' -d '{"text":"bad-key-401-test"}' >/dev/null
curl -sS -X POST "$BASE/api/admin/keys/$FID/credentials" -H "$AUTH" -H 'content-type: application/json' -d '{"text":"sk-mock-good-999999"}' >/dev/null
FO=$(curl -sS -X POST "$BASE/api/v1/chat/completions" -H "authorization: Bearer $FAILKEY" -H 'content-type: application/json' \
  -d '{"model":"mock-chat","messages":[{"role":"user","content":"hi"}]}')
contains "failed key failover to next" "$FO" 'Hello from the mock provider.'

echo
echo "── usage & revoke ──"
USAGE=$(curl -sS "$BASE/api/admin/keys/$ID1/usage" -H "$AUTH")
contains "usage totals present" "$USAGE" '"totalTokens"'
REQ=$(echo "$USAGE" | python3 -c 'import sys,json;print(json.load(sys.stdin)["totals"]["requests"])')
[ "$REQ" -ge 3 ] && ok "requests counted ($REQ)" || bad "requests counted ($REQ)"
SUM=$(curl -sS "$BASE/api/admin/usage/summary" -H "$AUTH")
contains "summary totals" "$SUM" '"requests"'
contains "per key rows" "$SUM" '"Friends"'
curl -sS -X POST "$BASE/api/admin/keys/$ID1/revoke" -H "$AUTH" >/dev/null
REV=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/v1/models" -H "authorization: Bearer $RAW1")
check "revoked key blocked" "$REV" "401"
curl -sS -X POST "$BASE/api/admin/keys/$ID1/activate" -H "$AUTH" >/dev/null
BACK=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/v1/models" -H "authorization: Bearer $RAW1")
check "reactivated key works" "$BACK" "200"

echo
echo "── settings ──"
SET=$(curl -sS -X PUT "$BASE/api/admin/settings" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"defaultRpm":60,"defaultRpd":1000,"defaultTpd":10000000,"defaultStreaming":true,"timezone":"Asia/Kolkata"}')
contains "settings saved" "$SET" '"defaultRpm":60'
NEWK=$(curl -sS -X POST "$BASE/api/admin/keys" -H "$AUTH" -H 'content-type: application/json' -d "{\"label\":\"Defaults\",\"providerId\":\"$PID\"}")
contains "new key inherits defaults" "$NEWK" '"rpm":60'

echo
echo "── admin playground (app chat) ──"
PG=$(curl -sS -X POST "$BASE/api/admin/playground/chat" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"keyId\":\"$ID2\",\"model\":\"mock-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
contains "playground reply via admin session" "$PG" 'Hello from the mock provider.'
PGS=$(curl -sS -N -X POST "$BASE/api/admin/playground/chat" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"keyId\":\"$ID2\",\"model\":\"mock-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true}")
contains "playground streaming" "$PGS" 'data:'
NOAUTH=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/admin/playground/chat" -H 'content-type: application/json' -d '{}')
check "playground needs admin session" "$NOAUTH" "401"

echo
echo "── json errors never leak secrets ──"
LEAK=$(grep -c "sk-mock-key-111111" server.log 2>/dev/null || true)
check "provider keys absent from logs" "$LEAK" "0"

echo
echo "════════════════════════════"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL_E2E_TESTS_PASSED" || echo "SOME_TESTS_FAILED"
