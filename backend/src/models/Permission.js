import mongoose from 'mongoose';

/**
 * Reference data, mirrored from src/constants/permissions.js at boot so the
 * Roles screen can render labels and group by module without the frontend
 * embedding a copy of the catalogue.
 *
 * Not tenant-scoped: the catalogue is a property of the software, not of a
 * customer. Authorization never reads this collection — it reads the constants.
 */
const permissionSchema = new mongoose.Schema(
  {
    _id: { type: String }, // the permission code
    module: { type: String, required: true, index: true },
    label: { type: String, required: true },
    restricted: { type: Boolean, default: false },
  },
  { versionKey: false, timestamps: true },
);

export const Permission = mongoose.model('Permission', permissionSchema);
export default Permission;
