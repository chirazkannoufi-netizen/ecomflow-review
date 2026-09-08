# =============================================================================
# EcomFlow — Image de l'API (NestJS)
#
# Contexte de build attendu : la RACINE du monorepo.
#   docker build -f apps/api/Dockerfile -t ecomflow-api .
#
# CHOIX STRUCTURANTS
#
#   MONOREPO. `@ecomflow/shared` est une dependance de l'API resolue par les
#   workspaces npm. Les manifestes des trois paquets sont donc copies AVANT le
#   code : tant qu'aucune dependance ne change, la couche d'installation reste
#   en cache, ce qui divise le temps de build par dix sur une modification de
#   code ordinaire.
#
#   PRISMA. `prisma generate` doit tourner apres l'installation et avant la
#   compilation : le client genere est importe par le code TypeScript.
#
#   UTILISATEUR NON PRIVILEGIE. Le conteneur de production tourne sous un
#   compte dedie. Une execution en root transformerait une evasion applicative
#   en compromission de l'hote.
#
#   PAS DE FICHIER .env DANS L'IMAGE. Les secrets sont injectes par
#   l'orchestrateur au demarrage (mission §47). Une image contenant des
#   secrets serait exfiltrable par simple `docker pull` depuis un registre.
# =============================================================================

# -----------------------------------------------------------------------------
# Base commune
# -----------------------------------------------------------------------------
FROM node:20.18-bookworm-slim AS base

# `openssl` est requis par les moteurs Prisma ; `dumb-init` fournit un PID 1
# correct, qui propage SIGTERM et permet un arret propre (drainage des
# requetes en cours, fermeture des connexions PostgreSQL).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# -----------------------------------------------------------------------------
# Dependances — couche mise en cache tant que les manifestes ne changent pas
# -----------------------------------------------------------------------------
FROM base AS deps

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# `npm ci` respecte strictement le verrou : deux builds du meme commit
# produisent exactement le meme arbre de dependances.
RUN npm ci --workspaces --include-workspace-root

# -----------------------------------------------------------------------------
# Compilation
# -----------------------------------------------------------------------------
FROM deps AS builder

COPY packages/shared packages/shared
COPY apps/api apps/api

# Le client Prisma doit exister avant la compilation TypeScript.
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

# `npm run build` de l'API compile d'abord le paquet partage, dont elle depend :
# elle se compile CONTRE `packages/shared/dist`, jamais contre ses sources
# (voir `apps/api/tsconfig.build.json`). C'est ce qui garantit une sortie a
# plat — `dist/main.js` — plutot qu'une arborescence de monorepo reconstituee.
RUN npm run build --workspace @ecomflow/api

# -----------------------------------------------------------------------------
# Cible DEVELOPPEMENT — rechargement a chaud, sources montees en volume
# -----------------------------------------------------------------------------
FROM deps AS development

ENV NODE_ENV=development

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npx prisma generate --schema apps/api/prisma/schema.prisma

# Le CLI Nest lit `nest-cli.json` depuis le repertoire courant : il doit donc
# etre lance depuis `apps/api`, pas depuis la racine du monorepo.
WORKDIR /app/apps/api

EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
# `nest start` directement, sans passer par le script npm : celui-ci charge un
# fichier `.env` local, absent de l'image, alors que les variables viennent
# ici de l'orchestrateur.
CMD ["npx", "nest", "start", "--watch"]

# -----------------------------------------------------------------------------
# Cible PRODUCTION — dependances d'execution uniquement
# -----------------------------------------------------------------------------
FROM base AS production

RUN groupadd --system --gid 1001 ecomflow \
    && useradd --system --uid 1001 --gid ecomflow ecomflow

# Manifestes puis installation SANS les dependances de developpement : ni
# TypeScript, ni Jest, ni le CLI Nest ne servent a l'execution.
#
# Le CLI `prisma`, lui, figure volontairement dans les dependances D'EXECUTION :
# le service de migration de la stack lance `prisma migrate deploy` depuis cette
# image, et `prisma generate` ci-dessous doit fonctionner apres une installation
# sans dependances de developpement.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

RUN npm ci --omit=dev --workspace @ecomflow/api --include-workspace-root \
    && npm cache clean --force

# Le schema et les migrations accompagnent l'image : `prisma migrate deploy`
# doit pouvoir tourner au demarrage du conteneur, sans depot source.
COPY apps/api/prisma apps/api/prisma
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

# Artefacts compiles
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/packages/shared/dist packages/shared/dist

RUN chown -R ecomflow:ecomflow /app
USER ecomflow

EXPOSE 3001

# Sonde de vivacite : le point d'entree `health/live` est volontairement servi
# HORS prefixe de version, pour que sa configuration ne change jamais.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
