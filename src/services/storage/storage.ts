import fs from "fs/promises"
import path from "path"
import crypto from "crypto"

const DEFAULT_MAX_BYTES = 512 * 1024 // 512 KB

export type StorageReadResult = {
	content: string
	truncated: boolean
	source: string
}

type AwsCredentials = {
	accessKeyId: string
	secretAccessKey: string
	sessionToken?: string
}

let cachedImdsCreds: { creds: AwsCredentials; expiration: number } | null = null

async function getAwsCredentials(): Promise<AwsCredentials | null> {
	if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
		return {
			accessKeyId: process.env.AWS_ACCESS_KEY_ID,
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
			sessionToken: process.env.AWS_SESSION_TOKEN,
		}
	}

	// ECS Container Credentials (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)
	if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
		try {
			const res = await fetch(`http://169.254.170.2${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`, {
				cache: "no-store",
			})
			if (res.ok) {
				const data = await res.json()
				return {
					accessKeyId: data.AccessKeyId,
					secretAccessKey: data.SecretAccessKey,
					sessionToken: data.Token,
				}
			}
		} catch {
			// Fall through
		}
	}

	// EC2 Instance Metadata Service (IMDSv2)
	if (cachedImdsCreds && Date.now() < cachedImdsCreds.expiration - 60_000) {
		return cachedImdsCreds.creds
	}

	try {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 1500)

		const tokenRes = await fetch("http://169.254.169.254/latest/api/token", {
			method: "PUT",
			headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
			signal: controller.signal,
			cache: "no-store",
		})
		clearTimeout(timeout)

		if (!tokenRes.ok) {
			return null
		}
		const imdsToken = await tokenRes.text()

		const roleRes = await fetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/", {
			headers: { "X-aws-ec2-metadata-token": imdsToken },
			cache: "no-store",
		})
		if (!roleRes.ok) {
			return null
		}
		const roleName = (await roleRes.text()).trim().split("\n")[0]
		if (!roleName) {
			return null
		}

		const credsRes = await fetch(
			`http://169.254.169.254/latest/meta-data/iam/security-credentials/${encodeURIComponent(roleName)}`,
			{
				headers: { "X-aws-ec2-metadata-token": imdsToken },
				cache: "no-store",
			}
		)
		if (!credsRes.ok) {
			return null
		}
		const data = await credsRes.json()
		const creds: AwsCredentials = {
			accessKeyId: data.AccessKeyId,
			secretAccessKey: data.SecretAccessKey,
			sessionToken: data.Token,
		}
		cachedImdsCreds = {
			creds,
			expiration: data.Expiration ? new Date(data.Expiration).getTime() : Date.now() + 300_000,
		}
		return creds
	} catch {
		return null
	}
}

function hmac(key: string | Buffer, data: string): Buffer {
	return crypto.createHmac("sha256", key).update(data, "utf8").digest()
}

function sha256Hex(data: string): string {
	return crypto.createHash("sha256").update(data, "utf8").digest("hex")
}

function encodeS3URIPath(key: string): string {
	return key
		.split("/")
		.map((segment) =>
			encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
		)
		.join("/")
}

async function s3Request(
	method: "HEAD" | "GET",
	bucket: string,
	key: string,
	region: string,
	creds: AwsCredentials,
	extraHeaders: Record<string, string> = {}
): Promise<Response> {
	const host = `${bucket}.s3.${region}.amazonaws.com`
	const canonicalUri = `/${encodeS3URIPath(key)}`
	const now = new Date()
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
	const dateStamp = amzDate.slice(0, 8)
	const payloadHash = sha256Hex("")

	const headers: Record<string, string> = {
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
		...extraHeaders,
	}
	if (creds.sessionToken) {
		headers["x-amz-security-token"] = creds.sessionToken
	}

	const sortedHeaderKeys = Object.keys(headers).sort()
	const canonicalHeaders = sortedHeaderKeys.map((k) => `${k.toLowerCase()}:${headers[k].trim()}\n`).join("")
	const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";")

	const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n")

	const credentialScope = `${dateStamp}/${region}/s3/aws4_request`
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n")

	const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp)
	const kRegion = hmac(kDate, region)
	const kService = hmac(kRegion, "s3")
	const kSigning = hmac(kService, "aws4_request")
	const signature = hmac(kSigning, stringToSign).toString("hex")

	const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

	const requestHeaders: Record<string, string> = {
		...headers,
		Authorization: authorization,
	}
	delete requestHeaders.host

	return fetch(`https://${host}${canonicalUri}`, {
		method,
		headers: requestHeaders,
		cache: "no-store",
	})
}

async function readS3File(s3Uri: string, maxBytes: number): Promise<StorageReadResult | null> {
	const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/)
	if (!match) {
		return null
	}
	const [, bucket, key] = match
	const creds = await getAwsCredentials()
	if (!creds) {
		return null
	}

	let region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-west-2"

	let headRes = await s3Request("HEAD", bucket, key, region, creds)
	// Handle bucket region redirect (301/400 with x-amz-bucket-region)
	const bucketRegion = headRes.headers.get("x-amz-bucket-region")
	if (bucketRegion && bucketRegion !== region) {
		region = bucketRegion
		headRes = await s3Request("HEAD", bucket, key, region, creds)
	}

	if (headRes.status === 404 || headRes.status === 403 || !headRes.ok) {
		return null
	}

	const contentLength = Number(headRes.headers.get("content-length") ?? 0)
	if (contentLength === 0) {
		return { content: "", truncated: false, source: s3Uri }
	}

	const truncated = contentLength > maxBytes
	const extraHeaders: Record<string, string> = {}
	if (truncated) {
		extraHeaders["range"] = `bytes=${contentLength - maxBytes}-${contentLength - 1}`
	}

	const getRes = await s3Request("GET", bucket, key, region, creds, extraHeaders)
	if (!getRes.ok) {
		return null
	}

	const content = await getRes.text()
	return {
		content,
		truncated,
		source: s3Uri,
	}
}

async function resolveLocalFilePath(rawPath: string): Promise<string | null> {
	const normalized = rawPath.startsWith("file://") ? rawPath.slice("file://".length) : rawPath
	const localRoot = process.env.LOCAL_STORAGE_ROOT

	const candidates: string[] = []
	if (localRoot) {
		candidates.push(path.join(localRoot, normalized))
	}
	candidates.push(normalized)

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate)
			if (stat.isFile()) {
				return candidate
			}
		} catch {
			// Try next candidate
		}
	}

	return null
}

async function readLocalFile(rawPath: string, maxBytes: number): Promise<StorageReadResult | null> {
	const resolved = await resolveLocalFilePath(rawPath)
	if (!resolved) {
		return null
	}

	try {
		const stat = await fs.stat(resolved)
		if (stat.size === 0) {
			return { content: "", truncated: false, source: rawPath }
		}

		const truncated = stat.size > maxBytes
		const readLength = truncated ? maxBytes : stat.size
		const readPosition = truncated ? stat.size - maxBytes : 0

		const handle = await fs.open(resolved, "r")
		try {
			const buffer = Buffer.alloc(readLength)
			const { bytesRead } = await handle.read(buffer, 0, readLength, readPosition)
			return {
				content: buffer.subarray(0, bytesRead).toString("utf8"),
				truncated,
				source: rawPath,
			}
		} finally {
			await handle.close()
		}
	} catch {
		return null
	}
}

export function joinStoragePath(baseDir: string, fileName: string): string {
	const trimmedBase = baseDir.replace(/\/+$/, "")
	const trimmedFile = fileName.replace(/^\/+/, "")
	return `${trimmedBase}/${trimmedFile}`
}

export async function readStorageFile(
	uriOrPath: string,
	opts?: { maxBytes?: number }
): Promise<StorageReadResult | null> {
	if (!uriOrPath) {
		return null
	}

	const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES

	if (uriOrPath.startsWith("s3://")) {
		return readS3File(uriOrPath, maxBytes)
	}

	return readLocalFile(uriOrPath, maxBytes)
}
