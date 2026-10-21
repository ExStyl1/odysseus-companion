#!/bin/bash

echo "async agent starting ..."

# Check if DP_TOKEN environment variable exists
if [ -z "$DP_TOKEN" ]; then
    echo "ERROR: DP_TOKEN environment variable is not set!"
    echo "Please run the container with: docker run -e DP_TOKEN=\"your_token\" nessy-async"
    exit 1
fi

echo "DP_TOKEN is set, proceeding..."

# Get nestor token from the API
echo "Getting Nestor token..."
curl -s --request POST \
  --url https://code-completion-nestor.tcsbank.ru/api/v2/token \
  --header 'Accept: application/json' \
  --header "Authorization: Bearer $DP_TOKEN" \
  --header 'Content-Type: application/json' > /tmp/nestor_token.json

# Get user info from DP
echo "Getting user info from DP..."
curl -s --request GET \
  --url https://devplatform.tcsbank.ru/api/v1/oauth2/userinfo \
  --header 'Accept: application/json' \
  --header "Authorization: Bearer $DP_TOKEN" \
  --header 'Content-Type: application/json' > /tmp/dp_user_info.json

# Check if both requests were successful
if [ ! -s /tmp/nestor_token.json ]; then
    echo "ERROR: Failed to get Nestor token"
    exit 1
fi

if [ ! -s /tmp/dp_user_info.json ]; then
    echo "ERROR: Failed to get DP user info"
    exit 1
fi

# Extract data from both JSON files and create dp_auth_creds.json
echo "Creating dp_auth_creds.json..."

# Get JWT from nestor token response
JWT=$(jq -r '.jwt' /tmp/nestor_token.json)

# Parse the JWT payload to get expiration time
# JWT uses base64url encoding: replace - with +, _ with /, add padding
JWT_PAYLOAD=$(echo "$JWT" | cut -d'.' -f2 | tr -- '-_' '+/' | awk '{n=length($0)%4; if(n==2) print $0"=="; else if(n==3) print $0"="; else print $0}')
DECODED_PAYLOAD=$(echo "$JWT_PAYLOAD" | base64 -d 2>/dev/null || echo '{}')
EXPIRES_AT=$(echo "$DECODED_PAYLOAD" | jq -r '.exp // 0')
EXPIRES_AT_MS=$((EXPIRES_AT * 1000))

# Get user info from DP response
USERNAME=$(jq -r '.preferred_username // empty' /tmp/dp_user_info.json)
USER_ID=$(jq -r '.sub // empty' /tmp/dp_user_info.json)

# Create the final dp_auth_creds.json
cat > /root/.nessy/dp_auth_creds.json <<EOF
{
  "jwt": "$JWT",
  "expiresAt": $EXPIRES_AT_MS,
  "username": "$USERNAME",
  "userId": "$USER_ID",
  "cachedModels": []
}
EOF

echo "dp_auth_creds.json created."
# cat /root/.nessy/dp_auth_creds.json | jq

# Create .dp directory and access_token.json for DP CLI compatibility
echo "Creating DP access token..."
mkdir -p /root/.dp

# Get current time and calculate expiration times
CURRENT_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.%6NZ")
EXPIRES_AT_TIME=$(date -u -d "+1 hour" +"%Y-%m-%dT%H:%M:%S.%6NZ" 2>/dev/null || date -u -v+1H +"%Y-%m-%dT%H:%M:%S.000000Z" 2>/dev/null)
REFRESH_EXPIRES_AT_TIME=$(date -u -d "+30 days" +"%Y-%m-%dT%H:%M:%S.%6NZ" 2>/dev/null || date -u -v+30d +"%Y-%m-%dT%H:%M:%S.000000Z" 2>/dev/null)

# Get user info from already parsed data
USER_EMAIL=$(jq -r '.email // empty' /tmp/dp_user_info.json)
if [ -z "$USER_EMAIL" ]; then
    USER_EMAIL="${USERNAME}@tbank.ru"
fi

# Create DP access_token.json
cat > /root/.dp/access_token.json <<EOF
{
  "tokens": [
    {
      "token": "$DP_TOKEN",
      "refresh_token": "",
      "created_at": "$CURRENT_TIME",
      "expires_at": "$EXPIRES_AT_TIME",
      "refresh_expires_at": "$REFRESH_EXPIRES_AT_TIME",
      "subject": {
        "id": "$USER_ID",
        "type": "user",
        "name": "$USER_EMAIL"
      },
      "type": "bearer"
    }
  ]
}
EOF

echo "DP access_token.json created:"
# cat /root/.dp/access_token.json | jq

PROMPTS_FILE="${PROMPTS_FILE:-/prompts.txt}"
if [ ! -f "$PROMPTS_FILE" ]; then
    echo "ERROR: Prompts file not found: $PROMPTS_FILE"
    exit 1
fi

echo "Running prompts from $PROMPTS_FILE ..."
echo "------------------------------------------------------------------"
PROMPT=$(cat "$PROMPTS_FILE")
nessy -p "$PROMPT"

