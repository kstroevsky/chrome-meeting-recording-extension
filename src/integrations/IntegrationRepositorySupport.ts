import { openIntegrationDatabase } from './IntegrationDatabase';

export abstract class IntegrationRepositorySupport {
  constructor(protected readonly factory?: IDBFactory) {}

  protected open(): Promise<IDBDatabase> {
    return openIntegrationDatabase(this.factory);
  }

  protected async readRow<T>(
    storeName: string,
    key: IDBValidKey,
    normalize: (value: unknown) => T | undefined,
    errorMessage: string,
  ): Promise<T | undefined> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onsuccess = () => resolve(normalize(request.result));
      request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
  }

  protected async readAllRows<T>(
    storeName: string,
    normalize: (value: unknown) => T | undefined,
    errorMessage: string,
  ): Promise<T[]> {
    const database = await this.open();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(
        request.result.map(normalize).filter((row): row is T => row != null),
      );
      request.onerror = () => reject(request.error ?? new Error(errorMessage));
    });
  }

  protected async writeRow<T>(
    storeName: string,
    value: T,
    errorMessage: string,
  ): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error(errorMessage));
      transaction.onabort = () => reject(transaction.error ?? new Error(`${errorMessage} (aborted)`));
    });
  }

  protected async deleteRow(storeName: string, key: IDBValidKey, errorMessage: string): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error(errorMessage));
      transaction.onabort = () => reject(transaction.error ?? new Error(`${errorMessage} (aborted)`));
    });
  }
}
