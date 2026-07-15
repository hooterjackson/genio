export type MusicKitInstance = {
  authorize(): Promise<string | void>;
};

export type MusicKitApi = {
  configure(options: Record<string, unknown>): Promise<void> | void;
  getInstance(): MusicKitInstance;
};

export async function configureFreshMusicKit(MusicKit: MusicKitApi, developerToken: string): Promise<MusicKitInstance> {
  await MusicKit.configure({
    developerToken,
    app: { name: "Needle", build: "1.0.0" },
  });
  return MusicKit.getInstance();
}
