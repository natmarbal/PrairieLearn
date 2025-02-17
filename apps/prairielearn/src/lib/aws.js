// @ts-check
const { Upload } = require('@aws-sdk/lib-storage');
const { S3 } = require('@aws-sdk/client-s3');
const fs = require('fs-extra');
const util = require('util');
const async = require('async');
const path = require('path');
const debug = require('debug')('prairielearn:' + path.basename(__filename, '.js'));
const { pipeline } = require('node:stream/promises');

const { logger } = require('@prairielearn/logger');
const { config } = require('./config');

/**
 * @param {import('@aws-sdk/client-s3').S3ClientConfig} extraConfig
 * @returns {import('@aws-sdk/client-s3').S3ClientConfig}
 */
module.exports.makeS3ClientConfig = function (extraConfig = {}) {
  const newConfig = module.exports.makeAwsClientConfig(extraConfig);

  if (!config.runningInEc2) {
    // If we're not running in EC2, assume we're running with a local s3rver instance.
    // See https://github.com/jamhall/s3rver for more details.
    newConfig.forcePathStyle = true;
    newConfig.credentials = {
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
    };
    newConfig.endpoint = 'http://localhost:5000';
  }

  return newConfig;
};

/**
 * @template {Record<string, any>} [T={}]
 * @param {T} extraConfig
 */
module.exports.makeAwsClientConfig = (extraConfig = /** @type {T} */ ({})) => {
  return {
    region: config.awsRegion,
    endpoint: process.env.AWS_ENDPOINT,
    ...config.awsServiceGlobalOptions,
    ...extraConfig,
  };
};

/**
 * Upload a local file or directory to S3.
 *
 * @param {string} s3Bucket - The S3 bucket name.
 * @param {string} s3Path - The S3 destination path.
 * @param {string} localPath - The local source path.
 * @param {boolean=} isDirectory - Whether the upload source is a directory (defaults to false).
 * @param {Buffer | null} buffer - A file buffer if local source path falsy.
 */
module.exports.uploadToS3Async = async function (
  s3Bucket,
  s3Path,
  localPath,
  isDirectory = false,
  buffer = null,
) {
  const s3 = new S3(module.exports.makeS3ClientConfig());

  let body;
  if (isDirectory) {
    body = '';
    s3Path += s3Path.endsWith('/') ? '' : '/';
  } else {
    if (localPath) {
      body = fs.createReadStream(localPath);
    } else if (buffer) {
      body = buffer;
    } else {
      throw new Error('must specify localPath or buffer');
    }
  }

  const res = await new Upload({
    client: s3,
    params: {
      Bucket: s3Bucket,
      Key: s3Path,
      Body: body,
    },
  }).done();
  if (localPath) {
    logger.verbose(`Uploaded localPath=${localPath} to s3://${s3Bucket}/${s3Path}`);
  } else {
    logger.verbose(`Uploaded buffer to s3://${s3Bucket}/${s3Path}`);
  }
  return res;
};
module.exports.uploadToS3 = util.callbackify(module.exports.uploadToS3Async);

/**
 * Recursively upload a directory to a path in S3, including empty
 * subfolders. The file `${localPath}/filename` will be uploaded
 * to `${s3Bucket}/${s3Path}/filename`.
 *
 * @param {string} s3Bucket Remote S3 bucket to upload into.
 * @param {string} s3Path Remote S3 path to upload into.
 * @param {string} localPath Local path to upload.
 * @param {string[]} ignoreList List of files to ignore. These should be paths relative to localPath.
 */
module.exports.uploadDirectoryToS3Async = async function (
  s3Bucket,
  s3Path,
  localPath,
  ignoreList = [],
) {
  const s3 = new S3(module.exports.makeS3ClientConfig());
  const ignoreSet = new Set(ignoreList);

  async function walkDirectory(subDir) {
    const localFullDir = path.join(localPath, subDir);
    const files = await fs.readdir(localFullDir);
    await async.each(files, async (file) => {
      const localFilePath = path.join(localPath, subDir, file);
      const s3FilePath = path.join(s3Path, subDir, file);
      const relFilePath = path.join(subDir, file);

      if (ignoreSet.has(relFilePath)) return;

      const stat = await fs.stat(localFilePath);
      if (stat.isFile()) {
        const fileBody = await fs.readFile(localFilePath);
        try {
          await new Upload({
            client: s3,
            params: {
              Bucket: s3Bucket,
              Key: s3FilePath,
              Body: fileBody,
            },
          }).done();
          logger.verbose(`Uploaded file ${localFilePath} to s3://${s3Bucket}/${s3FilePath}`);
        } catch (err) {
          logger.verbose(
            `Did not sync file ${localFilePath} to $s3://${s3Bucket}/${s3FilePath}: ${err}`,
          );
        }
      } else if (stat.isDirectory()) {
        const s3DirPath = s3FilePath.endsWith('/') ? s3FilePath : `${s3FilePath}/`;
        try {
          await s3.putObject({
            Bucket: s3Bucket,
            Key: s3DirPath,
            Body: '',
          });
          logger.verbose(`Uploaded directory ${localFilePath} to s3://${s3Bucket}/${s3DirPath}`);
        } catch (err) {
          logger.verbose(
            `Did not sync directory ${localFilePath} to $s3://${s3Bucket}/${s3DirPath}: ${err}`,
          );
        }
        await walkDirectory(relFilePath);
      }
    });
  }

  await walkDirectory('');
};
module.exports.uploadDirectoryToS3 = util.callbackify(module.exports.uploadDirectoryToS3Async);

/**
 * Download a file or directory from S3.
 *
 * @param {string} s3Bucket - The S3 bucket name.
 * @param {string} s3Path - The S3 source path.
 * @param {string} localPath - The local target path.
 * @param {object?} options - Optional parameters, including owner and group (optional, defaults to {}).
 */
module.exports.downloadFromS3Async = async function (s3Bucket, s3Path, localPath, options = {}) {
  if (localPath.endsWith('/')) {
    debug(`downloadFromS3: bypassing S3 and creating directory localPath=${localPath}`);
    await fs.promises.mkdir(localPath, { recursive: true });
    if (options.owner != null && options.group != null) {
      await fs.promises.chown(localPath, options.owner, options.group);
    }
    return;
  }

  debug(`downloadFromS3: creating containing directory for file localPath=${localPath}`);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  if (options.owner != null && options.group != null) {
    await fs.promises.chown(path.dirname(localPath), options.owner, options.group);
  }

  const s3 = new S3(module.exports.makeS3ClientConfig());
  const res = await s3.getObject({
    Bucket: s3Bucket,
    Key: s3Path,
  });
  const s3Stream = /** @type {import('stream').Readable} */ (res.Body);
  const fileStream = fs.createWriteStream(localPath);

  await pipeline(s3Stream, fileStream);

  if (options.owner != null && options.group != null) {
    await fs.chown(localPath, options.owner, options.group);
  }
};
module.exports.downloadFromS3 = util.callbackify(module.exports.downloadFromS3Async);

/**
 * Delete a file or directory from S3.
 *
 * @param {string} s3Bucket - The S3 bucket name.
 * @param {string} s3Path - The S3 target path.
 * @param {boolean=} isDirectory - Whether the deletion target is a directory (defaults to false).
 */
module.exports.deleteFromS3Async = async function (s3Bucket, s3Path, isDirectory = false) {
  const s3 = new S3(module.exports.makeS3ClientConfig());

  if (isDirectory) {
    s3Path += s3Path.endsWith('/') ? '' : '/';
  }
  await s3.deleteObject({
    Bucket: s3Bucket,
    Key: s3Path,
  });
  debug(`Deleted s3://${s3Bucket}/${s3Path}`);
};
module.exports.deleteFromS3 = util.callbackify(module.exports.deleteFromS3Async);

/**
 * Get a file from S3.
 *
 * @param {string} bucket - S3 bucket name.
 * @param {string} key - The S3 target path.
 * @param {boolean} buffer - Defaults to true to return buffer.
 * @return {Promise<Buffer | import('@aws-sdk/client-s3').GetObjectOutput['Body']>} Buffer or ReadableStream type from S3 file contents.
 */
module.exports.getFromS3Async = async function (bucket, key, buffer = true) {
  const s3 = new S3(module.exports.makeS3ClientConfig());
  const res = await s3.getObject({ Bucket: bucket, Key: key });
  if (!res.Body) throw new Error('No data returned from S3');
  logger.verbose(`Fetched data from s3://${bucket}/${key}`);

  if (buffer) {
    return Buffer.from(await res.Body.transformToByteArray());
  } else {
    return res.Body;
  }
};
