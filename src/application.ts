import { z } from 'zod';
import { AppError, requireThat } from './errors.js';
import { bindingSchema, bindingInput, prepareInput, operationSchema, handshakeSchema, type Binding, type Operation } from './contracts.js';
import { Github } from './github.js';
import { Store, digest } from './storage.js';
import type { RunnerPort } from './transport/runner.js';

export class Application {
  constructor(readonly store: Store, readonly gh: Github, readonly runner: RunnerPort) {}
  async binding(id: string): Promise<Binding> {
    const raw = await this.store.read('binding', id);
    requireThat(raw !== undefined, 'PROJECT_NOT_BOUND');
    const b = bindingSchema.safeParse(raw); requireThat(b.success, 'STATE_INVALID'); return b.data;
  }
  async bind(raw: z.input<typeof bindingInput>) {
    const input = bindingInput.parse(raw);
    return this.store.locked(async () => {
      await this.gh.identity(input.expectedAccount);
      const cs = await this.gh.get(input.codespaceName);
      requireThat(cs.repository.full_name.toLowerCase() === input.repository.toLowerCase(), 'REPOSITORY_MISMATCH');
      requireThat(cs.owner.login.toLowerCase() === input.expectedAccount.toLowerCase(), 'AUTH_IDENTITY_MISMATCH');
      const old = await this.store.read('binding', input.projectId);
      const current = old === undefined ? undefined : bindingSchema.parse(old);
      requireThat(input.expectedVersion === (current?.version ?? 0), 'BINDING_VERSION_CONFLICT');
      const { expectedVersion, ...fields } = input;
      const binding = bindingSchema.parse({ ...fields, version: expectedVersion + 1, schemaVersion: 1 });
      await this.store.write('binding', input.projectId, binding); return binding;
    });
  }
  async available(binding: Binding) {
    await this.gh.identity(binding.expectedAccount);
    const cs = await this.gh.get(binding.codespaceName);
    requireThat(cs.repository.full_name.toLowerCase() === binding.repository.toLowerCase(), 'REPOSITORY_MISMATCH');
    requireThat(cs.owner.login.toLowerCase() === binding.expectedAccount.toLowerCase(), 'AUTH_IDENTITY_MISMATCH');
    requireThat(cs.state === 'Available', 'CODESPACE_NOT_READY');
  }
  async prepare(raw: z.input<typeof prepareInput>) {
    const input = prepareInput.parse(raw);
    return this.store.locked(async () => {
      const binding = await this.binding(input.projectId);
      const operationId = digest([input.projectId, input.requestId]);
      requireThat(!input.operationId || input.operationId === operationId, 'OPERATION_MISMATCH');
      const { locale: ignoredLocale, ...executionBinding } = binding;
      const planDigest = digest([executionBinding, input.policy]);
      const stored = await this.store.read('prepare', operationId);
      const old = stored === undefined ? undefined : operationSchema.parse(stored);
      requireThat(!old || old.digest === planDigest, 'IDEMPOTENCY_CONFLICT');
      const operation: Operation = { schemaVersion: 1, operationId, digest: planDigest, projectId: input.projectId, state: 'probing', observation: 'unknown', errorCode: null, handshake: null, updatedAt: new Date().toISOString() };
      await this.store.write('prepare', operationId, operation);
      try {
        await this.available(binding);
        operation.handshake = handshakeSchema.parse(await this.runner.call(binding, 'handshake'));
        operation.state = 'ready'; operation.observation = 'reachable';
      } catch (e) {
        const code = e instanceof AppError ? e.code : 'INTERNAL_ERROR';
        operation.state = ['TRANSPORT_UNAVAILABLE', 'PROCESS_TIMEOUT', 'PROCESS_CLEANUP_UNCONFIRMED', 'GITHUB_REQUEST_FAILED', 'OUTPUT_LIMIT'].includes(code) ? 'unknown' : 'failed';
        operation.errorCode = code;
      }
      operation.updatedAt = new Date().toISOString();
      await this.store.write('prepare', operationId, operation); return operation;
    });
  }
  async probe(project: string, request: string, action: 'start' | 'status') {
    return this.store.locked(async () => {
      const b = await this.binding(project); await this.available(b);
      const id = digest([b.expectedAccount.toLowerCase(), b.repository.toLowerCase(), b.codespaceName, b.remoteProjectRoot, request]);
      return this.runner.call(b, action === 'start' ? 'diagnostic_start' : 'diagnostic_get', id);
    });
  }
}
