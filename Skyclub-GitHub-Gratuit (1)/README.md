# 🎴 Skyclub — jouer au Skyjo gratuitement avec GitHub

Un **pseudo**, un **code de salon privé**, jusqu'à **8 joueurs** ; aucune inscription Skyclub. Jeu en temps réel sur mobile ou ordinateur.

## Héberger gratuitement et partager une URL

**Il faut deux services gratuits :** GitHub héberge le dépôt *de code* ; Render Free fait fonctionner le serveur Node.js et les connexions WebSocket. **Ne choisis pas GitHub Pages / Settings → Pages : ce jeu n'est pas un site purement statique.**

### Étape A — mettre le code sur GitHub

1. Décompresse ce ZIP dans un dossier, par exemple `skyclub`. **Les fichiers `render.yaml`, `package.json`, `server.js` doivent être à la racine du dépôt GitHub** (pas dans un sous-dossier `skyclub/`).
2. Sur <https://github.com/new>, crée un dépôt `skyclub` vide, de préférence **privé**, sans README ni .gitignore automatique.
3. Ouvre le terminal dans le dossier qui contient `render.yaml` et exécute :

```bash
git init
git add .
git commit -m "Skyclub : jeu multijoueur sans compte"
git branch -M main
git remote add origin https://github.com/TON-PSEUDO/skyclub.git
git push -u origin main
```

Remplace **TON-PSEUDO** par ton identifiant GitHub. GitHub peut te demander de t'authentifier (n'utilise pas ton mot de passe GitHub directement dans Git). Si un dépôt Git est déjà présent, ne refais pas `git init` ni `git remote add origin`.

### Étape B — le publier gratuitement sur Render

1. Va sur <https://dashboard.render.com/>. Tu peux créer ton compte en passant par GitHub.
2. Choisis **New → Blueprint**, puis sélectionne ton dépôt GitHub `skyclub` et la branche `main`.
3. Render lira automatiquement `render.yaml`. Vérifie que l'offre affichée est **Free ($0)**, puis valide le déploiement.
4. À la fin du déploiement, ouvre l'adresse HTTPS indiquée par Render, du type **`https://skyclub-xxxx.onrender.com`** : **c'est cette adresse qu'il faut partager**.
5. Chacun entre son pseudo puis le code du salon. Aucun compte Skyclub n'est requis.

⚠️ **Garde l'offre Free sélectionnée.** Pour éviter toute facturation imprévue, ne configure pas de carte bancaire / de facturation automatique pour ce petit projet. Les ressources gratuites sont plafonnées.

### Mettre Skyclub à jour depuis le terminal

Après avoir modifié les fichiers, **dans le dossier GitHub du projet** :

```bash
git add .
git commit -m "Mise à jour Skyclub"
git push
```

Le nouveau code est alors automatiquement redéployé depuis GitHub. **L'URL publique reste la même.** Tu peux suivre le statut sur Render → ton service → Events/Logs.

Si tu reçois un nouveau ZIP de Skyclub, extrait d'abord ses fichiers **dans ce même dossier Git**, sans effacer le dossier caché `.git`, puis utilise les trois commandes ci-dessus. Sur Windows, le terminal PowerShell convient aussi.

### Gratuit : limites importantes

- **GitHub seul ne peut pas faire tourner le serveur** du jeu ; GitHub Pages ne prend en charge que les sites statiques.
- Render Free se **met en veille après 15 minutes sans trafic entrant**, et le premier accès peut mettre **environ une minute** à le réveiller. Pendant une partie active, les échanges WebSocket aident à garder le service éveillé.
- **Render Free a un disque éphémère** : si le service redémarre, se met en veille ou si tu pousses une mise à jour, ses sauvegardes locales (salons et identités d'invités) peuvent disparaître. **Termine les parties avant de publier une nouvelle version.** L'hébergement gratuit est adapté aux soirées occasionnelles, pas à des parties sauvegardées durablement.
- Render limite ses ressources et son temps d'utilisation mensuel. Vérifie les plafonds actuels sur <https://render.com/docs/free>.
- Le projet est prévu pour **une seule instance** du serveur. Ne crée pas plusieurs services séparés pour le même site.

## Sécurité

- Pseudos sans compte ni mots de passe, sessions privées en cookie `HttpOnly`/`SameSite=Strict`, `Secure` via HTTPS.
- Vérification des coups et des droits côté serveur, cartes cachées privées, limites de débit, protection anti-CSRF/origine des WebSockets, CSP et limite de 8 joueurs par salon.
- `TRUST_PROXY=1` est prévu uniquement pour le reverse proxy HTTPS de Render. N'expose pas directement cette configuration sur un port HTTP public.
- Le répertoire `data/` n'est **jamais envoyé sur GitHub** (`.gitignore`) : il contient les sessions et les salons. N'y ajoute pas de fichiers de sauvegarde à la main.
- Un code de salon est un accès à la partie ; partage-le seulement avec tes amis. Il ne prouve pas l'identité réelle des personnes.

## Lancer et tester localement

Node.js version 22 minimum :

```bash
npm test
npm start
```

Ouvre <http://localhost:3000> sur ton ordinateur (local seulement). Aucun `npm install` requis pour lancer le jeu : il n'utilise aucune dépendance extérieure.

Le fichier [`render.yaml`](render.yaml) configure Render Free, et [`.github/workflows/tests.yml`](.github/workflows/tests.yml) lance les tests à chaque changement sur GitHub. Toutes les règles du jeu, le détail des protections et les autres possibilités d'hébergement sont dans [`docs/README_LOCAL_ET_SECURITE.md`](docs/README_LOCAL_ET_SECURITE.md).

Projet indépendant, non affilié à Magilano ; l'interface et les cartes sont originales.
