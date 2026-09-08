# =============================================================================
# EcomFlow — Image du frontend (Next.js)
#
# Contexte de build attendu : la RACINE du monorepo.
#   docker build -f apps/web/Dockerfile -t ecomflow-web .
#
# CHOIX STRUCTURANTS
#
#   SORTIE `standalone`. Next.js produit un serveur autonome embarquant ses
#   seules dependances reellement utilisees. L'image finale pese quelques
#   dizaines de megaoctets au lieu de plusieurs centaines.
#
#   VARIABLES `NEXT_PUBLIC_*` FIGEES A LA COMPILATION. Elles sont inlinees
#   dans le bundle envoye au navigateur : les changer exige de reconstruire
#   l'image. `NEXT_PUBLIC_API_URL` est donc un ARGUMENT DE BUILD, et non une
#   variable d'execution. Une image construite pour la recette ne peut pas
#   etre promue telle quelle en production — c'est volontaire, cela evite de
#   pointer une interface de production vers une API de test.
#
#   AUCUN SECRET. Ce qui entre ici part dans le navigateur de chaque visiteur.
#   Seules des URL publiques y figurent (mission §47).
# =============================================================================

FROM node:20.18-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# -----------------------------------------------------------------------------
# Dependances
# -----------------------------------------------------------------------------
FROM base AS deps

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --workspaces --include-workspace-root

# -----------------------------------------------------------------------------
# Cible DEVELOPPEMENT — rechargement a chaud
# -----------------------------------------------------------------------------
FROM deps AS development

ENV NODE_ENV=development

COPY packages/shared packages/shared
COPY apps/web apps/web

WORKDIR /app/apps/web
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "dev"]

# -----------------------------------------------------------------------------
# Compilation
# -----------------------------------------------------------------------------
FROM deps AS builder

# URL publique de l'API, inlinee dans le bundle client.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npm run build --workspace @ecomflow/web

# -----------------------------------------------------------------------------
# Cible PRODUCTION
# -----------------------------------------------------------------------------
FROM base AS production

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 ecomflow \
    && useradd --system --uid 1001 --gid ecomflow ecomflow

# La sortie `standalone` embarque deja son propre `node_modules` reduit ;
# `static` et `public` restent servis a part.
COPY --from=builder --chown=ecomflow:ecomflow /app/apps/web/.next/standalone ./
COPY --from=builder --chown=ecomflow:ecomflow /app/apps/web/.next/static ./apps/web/.next/static

USER ecomflow

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/connexion',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
