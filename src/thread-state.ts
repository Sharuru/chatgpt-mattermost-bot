const mutedThreads = new Set<string>();

export function getThreadId(post: {id: string, root_id?: string}): string {
    return post.root_id || post.id;
}

export function muteThread(threadId: string) {
    mutedThreads.add(threadId);
}

export function unmuteThread(threadId: string) {
    mutedThreads.delete(threadId);
}

export function isThreadMuted(threadId: string): boolean {
    return mutedThreads.has(threadId);
}
