import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function notFound(error) {
  return error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey';
}

/** Thin S3 adapter used by the independent receiver. No extension code imports this module. */
export class R2Storage {
  #client;
  #bucket;
  #uploadUrlTtlSeconds;
  #playbackUrlTtlSeconds;

  constructor(options) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      throw new Error('S3 endpoint must be an HTTPS origin');
    }
    if (!options.bucket) throw new Error('S3 bucket is required');
    this.#bucket = options.bucket;
    this.#uploadUrlTtlSeconds = positiveInteger(options.uploadUrlTtlSeconds ?? 900, 'uploadUrlTtlSeconds');
    this.#playbackUrlTtlSeconds = positiveInteger(options.playbackUrlTtlSeconds ?? 1800, 'playbackUrlTtlSeconds');
    this.#client = new S3Client({
      region: options.region ?? 'auto',
      endpoint: endpoint.origin,
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
    this.uploadOrigin = options.uploadOrigin ?? (options.forcePathStyle
      ? endpoint.origin
      : `${endpoint.protocol}//${this.#bucket}.${endpoint.host}`);
    const parsedUploadOrigin = new URL(this.uploadOrigin);
    if (parsedUploadOrigin.protocol !== 'https:' || parsedUploadOrigin.origin !== this.uploadOrigin) {
      throw new Error('uploadOrigin must be an exact HTTPS origin');
    }
  }

  async createMultipart(key, contentType) {
    const result = await this.#client.send(new CreateMultipartUploadCommand({
      Bucket: this.#bucket,
      Key: key,
      ContentType: contentType,
    }));
    if (!result.UploadId) throw new Error('Storage did not create a multipart upload');
    return result.UploadId;
  }

  async abortMultipart(key, providerUploadId) {
    await this.#client.send(new AbortMultipartUploadCommand({
      Bucket: this.#bucket,
      Key: key,
      UploadId: providerUploadId,
    })).catch((error) => {
      if (!notFound(error)) throw error;
    });
  }

  async listParts(key, providerUploadId) {
    const parts = [];
    let marker;
    for (;;) {
      const page = await this.#client.send(new ListPartsCommand({
        Bucket: this.#bucket,
        Key: key,
        UploadId: providerUploadId,
        ...(marker ? { PartNumberMarker: marker } : {}),
      }));
      for (const part of page.Parts ?? []) {
        if (!part.PartNumber || !part.ETag || part.Size == null) {
          throw new Error('Storage returned an incomplete multipart part');
        }
        parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: Number(part.Size) });
      }
      if (!page.IsTruncated) return parts;
      marker = page.NextPartNumberMarker;
      if (!marker) throw new Error('Storage truncated ListParts without a continuation marker');
    }
  }

  async signUploadPart(key, providerUploadId, partNumber) {
    const url = await getSignedUrl(this.#client, new UploadPartCommand({
      Bucket: this.#bucket,
      Key: key,
      UploadId: providerUploadId,
      PartNumber: partNumber,
    }), { expiresIn: this.#uploadUrlTtlSeconds });
    if (new URL(url).origin !== this.uploadOrigin) {
      throw new Error('Presigned upload URL origin differs from advertised upload origin');
    }
    return {
      url,
      expiresAt: new Date(Date.now() + this.#uploadUrlTtlSeconds * 1000).toISOString(),
    };
  }

  async completeMultipart(key, providerUploadId, parts) {
    await this.#client.send(new CompleteMultipartUploadCommand({
      Bucket: this.#bucket,
      Key: key,
      UploadId: providerUploadId,
      MultipartUpload: {
        Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }));
  }

  async head(key) {
    try {
      const result = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return {
        bytes: Number(result.ContentLength ?? -1),
        contentType: result.ContentType?.split(';', 1)[0]?.trim().toLowerCase(),
      };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async signPlayback(key) {
    const url = await getSignedUrl(this.#client, new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }), { expiresIn: this.#playbackUrlTtlSeconds });
    return {
      url,
      expiresAt: new Date(Date.now() + this.#playbackUrlTtlSeconds * 1000).toISOString(),
    };
  }

  async deleteObject(key) {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
