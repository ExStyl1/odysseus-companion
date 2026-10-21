FROM --platform=linux/amd64 docker-hosted.artifactory.tcsbank.ru/cicd-images/nodejs-22

# Add Tinkoff CA certificates
ADD https://nexus.tcsbank.ru/repository/dist/tinkoff-root-certs/tinkoff-bundle.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/tinkoff-bundle.crt

WORKDIR /home/node/app

# Install jq for JSON processing
RUN apt-get update && apt-get install -y jq && apt-get clean && rm -rf /var/lib/apt/lists/*

# Configure npm for Tinkoff registry
RUN npm config set registry "https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/" \
  && npm config set strict-ssl false \
  && npm config set ca ""

# Install nessy-cli globally
ARG NESSY_CLI_VERSION=0.9.2
RUN npm install -g @nestor/nessy-cli@${NESSY_CLI_VERSION}

# Copy .nessy configuration to root home directory
COPY deploy/async/.nessy /root/.nessy

# Copy prompts file (can be overridden at runtime via -v /path/to/prompts.txt:/prompts.txt)
COPY deploy/async/prompts.txt /prompts.txt

# Copy entrypoint script
COPY deploy/async/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]
