
export const videoCodecs = ['vp8', 'h264', 'vp9', 'av1'] as const;

export type VideoCodec = (typeof videoCodecs)[number];
