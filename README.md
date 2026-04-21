# MailjetAPI

API JSON autonome en Node.js pour piloter Mailjet pour un utilisateur donne.

Le service expose un endpoint HTTP natif Node.js, sans framework externe. Il recoit des requetes JSON, stocke les identifiants Mailjet par utilisateur de facon chiffree, puis appelle l'API Mailjet avec `fetch`.

## Fonctionnalites

- Authentification applicative par header `X-App-Token`.
- Connexion/deconnexion d'un compte Mailjet par `user_id`.
- Recuperation des listes Mailjet.
- Creation d'une liste Mailjet.
- Import de contacts avec deduplication, rate limit et verrou par utilisateur.
- Stockage local chiffre des credentials Mailjet.
- Logs JSON persistants.
- Image Docker autonome Node.js 22 avec healthcheck.

## Configuration

Copier l'exemple :

```bash
cp .env.example .env
```

Configurer au minimum :

```env
APP_TOKEN=un-token-secret-long
APP_MASTER_KEY=une-cle-maitresse-de-32-caracteres-minimum
HTTP_PORT=8080
APP_CORS_ORIGINS=*
```

`APP_MASTER_KEY` sert a chiffrer les cles Mailjet stockees localement. Ne la change pas apres avoir connecte des utilisateurs, sinon les credentials deja stockes ne seront plus decryptables.

`APP_CORS_ORIGINS` controle les origines autorisees pour les appels depuis navigateur. En demo, `*` accepte toutes les origines. En production, utilise plutot une liste separee par virgules, par exemple `https://app.example.com,https://admin.example.com`.

## Lancement Docker

```bash
docker compose up -d --build
```

Verifier le healthcheck :

```bash
curl http://localhost:8080/health
```

## Deploiement VPS

Sur le serveur :

```bash
git clone <url-du-repo> MailjetAPI
cd MailjetAPI
cp .env.example .env
nano .env
sh scripts/deploy.sh
```

Si le repo est deja en place :

```bash
git pull
sh scripts/deploy.sh
```

## Requetes API

Toutes les actions metier utilisent `POST /` avec :

```http
X-App-Token: <APP_TOKEN>
Content-Type: application/json
```

Les requetes `OPTIONS` sont acceptees pour les preflights CORS des navigateurs.

### Connecter un utilisateur

```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "X-App-Token: $APP_TOKEN" \
  -d '{
    "action": "connect",
    "user_id": "client-123",
    "api_key": "MAILJET_API_KEY",
    "api_secret": "MAILJET_API_SECRET"
  }'
```

### Recuperer les listes

```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "X-App-Token: $APP_TOKEN" \
  -d '{
    "action": "get_lists",
    "user_id": "client-123"
  }'
```

### Creer une liste

```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "X-App-Token: $APP_TOKEN" \
  -d '{
    "action": "create_list",
    "user_id": "client-123",
    "list_name": "Prospects"
  }'
```

### Importer des contacts

```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "X-App-Token: $APP_TOKEN" \
  -d '{
    "action": "import_contacts",
    "user_id": "client-123",
    "list_name": "Prospects",
    "contacts": [
      {"email": "alice@example.com", "name": "Alice"},
      {"email": "bob@example.com", "name": "Bob"}
    ]
  }'
```

## Donnees persistantes

Docker conserve les donnees dans deux volumes :

- `mailjet_storage` : credentials chiffres, locks et rate limit.
- `mailjet_logs` : logs applicatifs JSON.

## Securite

- Mets le service derriere HTTPS en production, par exemple via Nginx, Traefik ou Caddy.
- Garde `.env` hors Git.
- Utilise un `APP_TOKEN` long et aleatoire.
- Sauvegarde `APP_MASTER_KEY` dans un gestionnaire de secrets.
