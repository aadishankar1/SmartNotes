import type { AnnotationView, Replica, Session } from './types.js';

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
// Test fault: `?failSaves=1` on the page URL deterministically rejects the
// save/sync POST before it reaches the network, so a tester can observe the
// failed-save path; auth, reads and every other request stay untouched.
const SYNC_PATH = '/v1/sync';
function saveFaultArmed(): boolean { const search = typeof location === 'object' && location !== null ? location.search : ''; return new URLSearchParams(search).get('failSaves') === '1'; }
export class Api {
  constructor(private readonly session: () => Session | null) {}
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (method === 'POST' && path === SYNC_PATH && saveFaultArmed()) throw new ApiError(503, 'The server could not save this note (?failSaves=1 test fault). Your draft is kept on this device — remove the flag and retry.');
    const session = this.session(); const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(session ? { authorization: `Bearer ${session.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) { const data = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new ApiError(response.status, data?.error?.message ?? `Request failed (${response.status})`); }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
  signup(email: string, password: string, displayName: string) { return this.request<{ token:string; user:{email:string;displayName:string} }>('/v1/auth/signup', 'POST', { email, password, displayName }); }
  login(email: string, password: string) { return this.request<{ token:string; user:{email:string;displayName:string} }>('/v1/auth/login', 'POST', { email, password }); }
  notebooks() { return this.request<{ notebooks: Replica['notebook'][] }>('/v1/notebooks'); }
  createNotebook(title: string) { return this.request<{ notebook: Replica['notebook'] }>('/v1/notebooks', 'POST', { title }); }
  updateNotebook(id: string, title: string) { return this.request<{ notebook: Replica['notebook'] }>(`/v1/notebooks/${encodeURIComponent(id)}`, 'PATCH', { title }); }
  deleteNotebook(id: string) { return this.request<void>(`/v1/notebooks/${encodeURIComponent(id)}`, 'DELETE'); }
  viewNotebook(id: string) { return this.request<{ notebook: Replica['notebook']; notes: Replica['notes']; pdfs: Replica['pdfs']; cursor:number }>(`/v1/notebooks/${encodeURIComponent(id)}`); }
  createNote(notebookId: string, title: string) { return this.request<{ note: Replica['notes'][number] }>(`/v1/notebooks/${encodeURIComponent(notebookId)}/notes`, 'POST', { title, body: '', position: Date.now() }); }
  uploadPdf(notebookId: string, filename: string, content: string) { return this.request<{ pdf: Replica['pdfs'][number] }>('/v1/pdfs', 'POST', { notebookId, filename, content }); }
  annotations(pdfId: string) { return this.request<AnnotationView>(`/v1/pdfs/${encodeURIComponent(pdfId)}/annotations`); }
  addAnnotation(pdfId: string, text: string) { return this.request<{ annotation: AnnotationView['annotations'][number] }>(`/v1/pdfs/${encodeURIComponent(pdfId)}/annotations`, 'POST', { page: 0, kind: 'note', color: '#ffd60a', text }); }
  async pdfUrl(pdfId: string): Promise<string> {
    const session = this.session();
    const response = await fetch(`/v1/pdfs/${encodeURIComponent(pdfId)}/content`, { headers: session ? { authorization: `Bearer ${session.token}` } : {} });
    if (!response.ok) throw new ApiError(response.status, `Could not load PDF (${response.status})`);
    return URL.createObjectURL(await response.blob());
  }
}
