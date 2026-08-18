# Ubuntu production deployment

This directory deploys Business API, Knowledge Base, and AI Reply with Docker
Compose. Business API binds loopback port `8001`, Knowledge Base binds loopback
port `8010`, and AI Reply is reachable only on the Compose network at port
`8020`. Nginx exposes the first two services over the public IP on port `80`;
the existing domain-based personal site remains a separate virtual host.

Run all commands from the repository root on the server:

```bash
cd /opt/ai-customer-service
sudo docker compose --env-file deploy/production/.env \
  -f deploy/production/compose.yaml up -d --build
sudo docker compose --env-file deploy/production/.env \
  -f deploy/production/compose.yaml ps
```

Production data lives under `deploy/production/data/`. The `.env` file contains
secrets and must remain mode `0600`. Do not commit it.

Create an immediate backup with:

```bash
sudo deploy/production/scripts/backup.sh
```

The installed systemd timer runs daily and retains 14 days locally. Set
`OFFSITE_BACKUP_DIR` only to a separately mounted disk or NAS. Without such a
mount, backups remain on the same cloud disk and do not protect against server
or disk loss.

Restore is intentionally explicit and stops all three services:

```bash
sudo RESTORE_CONFIRM=yes deploy/production/scripts/restore.sh /path/to/backup.tar.gz
```
