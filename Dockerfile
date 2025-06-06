# base node image

FROM node:21-bullseye-slim as base

# set for base and all layer that inherit from it

ENV NODE_ENV production

# Install all node_modules, including dev dependencies

FROM base as deps

WORKDIR /transmitter

ADD package.json ./
RUN npm install --include=dev

# Setup production node_modules

FROM base as production-deps

WORKDIR /transmitter

COPY --from=deps /transmitter/node_modules /transmitter/node_modules
ADD package.json ./
RUN npm prune --omit=dev

# Build the app

FROM base as build

WORKDIR /transmitter

COPY --from=deps /transmitter/node_modules /transmitter/node_modules

ADD . .
RUN npm run build

# Finally, build the production image with minimal footprint

FROM base

WORKDIR /transmitter

COPY --from=production-deps /transmitter/node_modules /transmitter/node_modules

COPY --from=build /transmitter/build /transmitter/build
COPY --from=build /transmitter/public /transmitter/public
ADD . .

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --gid 1001 nodeuser

# Set ownership of application files
RUN chown -R nodeuser:nodejs /transmitter

# Switch to non-root user for runtime
USER nodeuser

CMD ["npm", "start"]