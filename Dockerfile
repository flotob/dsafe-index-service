# dsafe-index-service — watches Safe deployments on Gnosis and publishes a
# signed owner→Safes index to a Swarm feed. Runs as a background daemon; no
# public port. Publishes through an external bee node (BEE_URL).
FROM node:22-alpine

RUN apk add --no-cache tini

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# State + output live on a volume so publish-on-change survives restarts.
ENV BEE_URL=http://bee:1633 \
    GNOSIS_RPC=https://rpc.gnosischain.com \
    CHAIN_ID=100 \
    INTERVAL_MINUTES=60 \
    OUT_DIR=/data/out \
    STATE_FILE=/data/state.json \
    NODE_ENV=production

VOLUME /data

# tini for correct signal handling; npm start = the daemon loop.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
