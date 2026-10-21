# Build stage
FROM docker-hosted.artifactory.tcsbank.ru/cicd-images/nodejs-22 AS builder

ARG UBUNTU_VER=jammy

RUN echo "deb [trusted=yes] http://apt-proxy.tcsbank.ru/repository/apt-ubuntu/ ${UBUNTU_VER} main restricted universe multiverse" > /etc/apt/sources.list && \
    echo "deb [trusted=yes] http://apt-proxy.tcsbank.ru/repository/apt-ubuntu/ ${UBUNTU_VER}-updates main restricted universe multiverse" >> /etc/apt/sources.list && \
    echo "deb [trusted=yes] http://apt-proxy.tcsbank.ru/repository/apt-ubuntu/ ${UBUNTU_VER}-backports main restricted universe multiverse" >> /etc/apt/sources.list && \
    echo "deb [trusted=yes] http://apt-proxy.tcsbank.ru/repository/apt-ubuntu/ ${UBUNTU_VER}-security main restricted universe multiverse" >> /etc/apt/sources.list
ADD https://nexus.tcsbank.ru/repository/dist/tinkoff-root-certs/tinkoff-bundle.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  make \
  g++ \
  git \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Set up npm global package folder
RUN mkdir -p /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Copy source code
COPY . /home/node/app
WORKDIR /home/node/app

# Install dependencies and build packages
# Use scripts/build.js which handles workspace dependencies in correct order
RUN npm config set registry "https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/" \
  && npm config set strict-ssl false \
  && npm config set ca "" \
  && npm ci \
  && npm run build \
  && npm run bundle \
  && npm run prepare:package \
  && cd dist && npm pack

# Runtime stage
FROM docker-hosted.artifactory.tcsbank.ru/cicd-images/nodejs-22

ARG SANDBOX_NAME="nessy-cli-sandbox"
ARG CLI_VERSION_ARG
ENV SANDBOX="$SANDBOX_NAME"
ENV CLI_VERSION=$CLI_VERSION_ARG

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  man-db \
  curl \
  dnsutils \
  less \
  jq \
  bc \
  glab \
  git \
  unzip \
  rsync \
  ripgrep \
  procps \
  psmisc \
  lsof \
  socat \
  ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Set up npm global package folder
RUN mkdir -p /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Copy bundled package from builder stage
COPY --from=builder /home/node/app/dist/*.tgz /tmp/

# Install built packages globally
RUN npm config set registry "https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/" \
 && npm config set strict-ssl false \
 && npm config set ca "" \
 && npm install -g /tmp/*.tgz \
 && npm cache clean --force \
 && rm -rf /tmp/*.tgz

USER nessy
# Default entrypoint when none specified
CMD ["nessy"]
