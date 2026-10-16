import multer from 'multer';
import {
  ALLOWED_TYPES, MAX_FILE_BYTES, MAX_FILES_PER_REQUEST,
} from '../constants/documents.js';
import { DomainError } from '../utils/errors.js';

/**
 * Upload middleware.
 *
 * MEMORY storage, not disk. Multer's disk storage writes the file before any
 * of our code sees it, which means a rejected upload has already touched the
 * filesystem and something has to clean it up. Holding the bytes in memory lets
 * documentService verify the magic numbers BEFORE anything is written, so a
 * file that lied about its type never exists on our disk at all.
 *
 * The trade is memory: 15MB × 10 files is the worst case per request, bounded
 * by the limits below and by the rate limiter in front of the route.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES_PER_REQUEST,
    // Without this, a request can carry unlimited text fields and multer will
    // happily buffer them all.
    fields: 20,
    fieldSize: 100 * 1024,
    // Long field names are only ever an attempt to break something downstream.
    fieldNameSize: 200,
  },
  fileFilter(req, file, cb) {
    // A cheap first gate on the declared type. It is NOT the real check —
    // the client supplies this header — but rejecting here avoids buffering
    // 15MB of something we would refuse anyway.
    if (!ALLOWED_TYPES[file.mimetype]) {
      cb(new DomainError(`${file.mimetype} files are not accepted`, 'FILE_TYPE_NOT_ALLOWED'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Translates multer's own errors into the project's error shape.
 *
 * Without this a file over the limit surfaces as an unhandled MulterError and
 * becomes a 500 — telling the user the server broke when in fact they did
 * something we deliberately refuse. A limit is a rule, and a rule being
 * enforced is a 4xx.
 */
function translate(err) {
  if (!(err instanceof multer.MulterError)) return err;

  const map = {
    LIMIT_FILE_SIZE: [
      `Files must be ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB or smaller`,
      'FILE_TOO_LARGE',
    ],
    LIMIT_FILE_COUNT: [`At most ${MAX_FILES_PER_REQUEST} files per upload`, 'TOO_MANY_FILES'],
    LIMIT_UNEXPECTED_FILE: ['Unexpected file field', 'UNEXPECTED_FILE_FIELD'],
    LIMIT_FIELD_COUNT: ['Too many form fields', 'TOO_MANY_FIELDS'],
    LIMIT_FIELD_VALUE: ['A form field is too long', 'FIELD_TOO_LONG'],
    LIMIT_FIELD_KEY: ['A form field name is too long', 'FIELD_NAME_TOO_LONG'],
  };

  const [message, code] = map[err.code] ?? ['That upload could not be accepted', 'UPLOAD_REJECTED'];
  return new DomainError(message, code);
}

/** Accepts exactly one file, on the field named `file`. */
export function singleFile(field = 'file') {
  const handler = upload.single(field);

  return function middleware(req, res, next) {
    handler(req, res, (err) => (err ? next(translate(err)) : next()));
  };
}

export default singleFile;
