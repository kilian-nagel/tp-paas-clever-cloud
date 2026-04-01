# Application

## Services requis et variables d'environnement

Cette application nécessite les services suivants pour fonctionner :

- **PostgreSQL** : Configurable via la variable d'environnement `POSTGRESQL_ADDON_URI`.
- **Redis** : Configurable via la variable d'environnement `REDIS_ADDON_URI` (par défaut : `redis://localhost:6379`).

## Démarrer avec Node.js
```bash
npm install
npm start
```