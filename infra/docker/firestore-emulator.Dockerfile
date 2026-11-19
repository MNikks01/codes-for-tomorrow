# Firestore emulator for local development and tests. Never used in production.
FROM node:26-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global firebase-tools@15.37.0 && npm cache clean --force

WORKDIR /emulator
COPY firebase.json ./
COPY firestore ./firestore

# Bake the emulator JAR into the image so container start needs no network.
RUN firebase setup:emulators:firestore

EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=30 \
  CMD node -e "fetch('http://127.0.0.1:8080').then(()=>process.exit(0)).catch(()=>process.exit(1))"

# "demo-" projects never reach real Google services and need no credentials.
CMD ["firebase", "emulators:start", "--only", "firestore", "--project", "demo-chat-backend"]
