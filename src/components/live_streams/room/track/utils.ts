/**
 * @internal
 */
export function getNewAudioContext(): AudioContext | void {
    const audioContext =
        // @ts-ignore
        typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (audioContext) {
        return new AudioContext({latencyHint: 'interactive'});
    }
}