[![Build](https://github.com/GallVp/nf-shard/actions/workflows/ci.yml/badge.svg)](https://github.com/GallVp/nf-shard/actions/workflows/ci.yml)
![Version badge](https://ghcr-badge.egpl.dev/GallVp/nf-shard/latest_tag?color=%236d52f4&ignore=latest&label=Version&trim=)
![Size badge](https://ghcr-badge.egpl.dev/GallVp/nf-shard/size?color=%23fa0092&tag=latest&label=Image+size&trim=)

![nf-shard Logo](./assets/logo.png)

# nf-shard

nf-shard is an open source user interface for monitoring Nextflow runs, searching historical runs and analysing metrics. It was designed as drop-in replacement for community [nf-tower](https://github.com/seqeralabs/nf-tower), however it does not aim to replace Enterprise nf-tower.

[![Foo](./assets/play.png)](https://www.youtube.com/watch?v=Fzq9cqozwEU)

## Usage in Nextflow

Once nf-shard is running to integrate it into your Nextflow project you should add similar snippet to your `nextflow.config`. The exact form of this snippet will be displayed under `Get Started` once you start nf-shard.

```nextflow
tower {
    enabled = true
    workspaceId = "empty or a number"
    accessToken = "non-empty"
    endpoint = "http://localhost:3000/api"
}
```

## Deployment

Following instructions allows to run `nf-shard` locally. Make sure [`Docker`](https://docs.docker.com/engine/install/) and [`docker-compose`](https://docs.docker.com/compose/install/linux/) are already installed.

### Method 1 - `bash` 1-liner - Local

```bash
curl -s \
    https://raw.githubusercontent.com/GallVp/nf-shard/refs/heads/main/deploy-local.sh \
    | bash -s -- -p <Postgresql password> -u <nf-shard username> -s <nf-shard password>
```

Or, force redeployment,

```bash
curl -s \
    https://raw.githubusercontent.com/GallVp/nf-shard/refs/heads/main/deploy-local.sh \
    | bash -s -- -p <Postgresql password> -u <nf-shard username> -s <nf-shard password> -f
```

### Method 2 - docker-compose

Download the repository,

```bash
git clone git@github.com:GallVp/nf-shard.git
```

Setup an `.env` file (you can copy [`.env-example`](.env-example) as a starting point),

```bash
cp .env-example .env
```

Or generate one directly:

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 16)
cat << EOF > .env
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_URI=postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/postgres?schema=public
APP_SECRET_KEY=$(openssl rand -hex 32)
DEFAULT_ACCESS_TOKEN=$(openssl rand -hex 32 | sed -E 's/(.{16})(.{16})(.{16})(.{16})/\1-\2-\3-\4/')
APP_USERNAME=admin
APP_PASSWORD=
LOG_LEVEL=INFO
NXF_HOME=/some/path/
EOF
```

These environment variables are:

- `POSTGRES_PASSWORD`: Password for the PostgreSQL server. This should be a strong password, preferably generated with a password generator.
- `POSTGRES_URI`: Connection URI for the PostgreSQL server.
- `APP_SECRET_KEY`: A high entropy secret key used by nf-shard to create signed credentials such as a session token.
- `DEFAULT_ACCESS_TOKEN`: The default `accessToken` for the default workspace within nf-shard. This is optional. If left empty, the default workspace is locked forever. More workspaces can still be created in nf-shard.
- `APP_USERNAME`: Username for logging into nf-shard.
- `APP_PASSWORD`: Password for logging into nf-shard.
- `NXF_HOME`: Host directory from which local Nextflow runs are launched (or where local `work/` directories reside). Bind-mounted read-only into the `nextjs` container so nf-shard can display task and run logs for local runs.
- `AWS_REGION` *(optional)*: AWS region when reading task/run logs from `s3://` work directories (credentials are resolved automatically from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, ECS task roles, or EC2 instance profiles via IMDSv2).
- `LOCAL_STORAGE_ROOT` *(optional)*: Prefix prepended to local filesystem paths when reading logs (useful if host paths are mounted under a container prefix such as `/host`).

Start the containers,

```bash
docker compose --profile all up --detach
```

### Method 3 - AWS

Register a domain name under [Amazon Route 53](https://aws.amazon.com/route53/). For the domain name, get a SSL/TLS certificate from [Amazon Certificate Manager](https://aws.amazon.com/certificate-manager/)

Download the repository and run the deployment script,

```bash
git clone git@github.com:GallVp/nf-shard.git && cd nf-shard

bash deploy-aws.sh \
    -p <Postgresql password> \
    -u <nf-shard username> \
    -s <nf-shard password> \
    -v <VPC Id> \
    -n <Public subnet id in zone 1> \
    -b <Public subnet id in zone 2> \
    -k <Key pair name> \
    -c <ACM certificate ARN> \
    -d <Domain name> \
    -z <Hosted zone Id from Route 53>
```

## Development

Setup the secrets and start the PostgreSQL server,

`Note:` Since connection to PostgreSQL now happens outside of docker, you should update your `.env` to specify `localhost`

```bash
POSTGRES_URI=postgresql://postgres:${POSTGRES_PASSWORD}@localhost:5435/postgres?schema=public
```

```bash
docker compose --profile db up --detach
```

Run the dev server,

```bash
yarn
yarn generate
yarn migrate
yarn dev
```

## Viewing Task & Run Logs

nf-shard can display per-task execution logs (`.command.log`, `.command.out`, `.command.err`) in the Task Details slide-over panel and run-level Nextflow logs (`.nextflow.log` / console output) in the Run page **Logs** tab.

- **Local runs**: Ensure the Nextflow launch and `work/` directories are accessible to the nf-shard server (via the `NXF_HOME` bind mount in [`docker-compose.yml`](docker-compose.yml)).
- **AWS S3 `workDir`s (`s3://...`)**: Task logs are read directly from S3 using EC2 instance role credentials (IMDSv2), ECS task roles, or `AWS_*` environment variables. To also archive run-level `.nextflow.log` and console output to S3 automatically via Nextflow's `nf-tower` plugin, set `NXF_CLOUDCACHE_PATH` (or an S3 `workDir`) along with `NXF_LOG_FILE` and `NXF_OUT_FILE` when launching Nextflow.

## Stack

- NextJS/React/Typescript
- PostgreSQL
- Prisma ORM
- Cypress E2E testing

## Contribution Workflow

The contribution workflow is similar to nf-core pipelines. Please fork the repo, make changes and create a PR for review and approval to the `develop` branch. The test workflow is documented in [test/scripts/test_cypress_all.sh](test/scripts/test_cypress_all.sh).

## Features

- `nf-tower` plugin compatible API.
- List of historical runs
- Run details
- Task and run-level execution log viewer (local filesystem and S3 `workDir` support)
- Workspaces
- Authentication via workspaces tokens
- Ability to attach multiple tags for each workflow. Tags are visible in the UI and can be used in search. `--tags tag1,tag2...` parameter is used for attaching the tags.
- Indexed search by workflow ID, run name, user name, tag, project name, before date, after date.
- [Slack integration](https://www.youtube.com/watch?v=8lWLgvROQ8Q)

## Roadmap

- Store and submit pipeline jobs from Shard UI -- [shard-worker](https://github.com/AugustDev/shard-worker)
- Dedicated plugin
- Download reports
- [tRPC](https://trpc.io/) client/server communication

## Authors

- Augustinas Malinauskas
- Usman Rashid