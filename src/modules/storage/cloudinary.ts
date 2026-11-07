import pkg, { type UploadApiResponse } from 'cloudinary';
const { v2: cloudinary } = pkg;
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../../config/config.js';
import { AppError } from '../../utils/index.js';
import { UNSUPPORTED_MEDIA_TYPE } from '../../constants/statusCode.js';

// Configure Cloudinary
cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret
});

const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
const allowedDocTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
];

// Configure Multer for memory storage. Put the `verify` middleware before it on routes
// that need a logged-in user; upload errors are handled by the global error handler.
const uploadManager = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
    },
    fileFilter: (req, file, cb) => {
        if (allowedImageTypes.includes(file.mimetype) || allowedDocTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new AppError('Invalid file type', UNSUPPORTED_MEDIA_TYPE));
        }
    }
});

// Streams the in-memory file to Cloudinary (no base64 copy) and returns its HTTPS URL
const uploadToCloudinary = async (file: Express.Multer.File, folder: string = config.app.name) => {
    const isImage = file.mimetype.startsWith('image/');
    const extension = path.extname(file.originalname);
    // Raw files keep their extension so the URL serves the right file type
    const publicId = `${file.fieldname}-${randomUUID()}${isImage ? '' : extension}`;

    try {
        const result = await new Promise<UploadApiResponse>((resolve, reject) => {
            cloudinary.uploader.upload_stream({
                folder,
                resource_type: isImage ? 'image' : 'raw',
                access_mode: 'public',
                public_id: publicId,
                transformation: isImage ? [
                    { quality: 'auto:best' },
                    { fetch_format: 'auto' }
                ] : []
            }, (error, result) => {
                if (error || !result) {
                    return reject(error ?? new Error('No response from Cloudinary'));
                }
                resolve(result);
            }).end(file.buffer);
        });

        return result.secure_url;
    } catch (error: any) {
        throw new Error(`Failed to upload to Cloudinary: ${error.message}`);
    }
};

export { uploadManager, uploadToCloudinary };
