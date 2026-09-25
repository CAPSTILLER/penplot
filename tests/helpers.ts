import { ENDER5_PRO, type Profile, normalizeProfile } from '../src/lib/profile';
export const prof = (p: Partial<Profile> = {}): Profile => normalizeProfile({ ...ENDER5_PRO, ...p });
