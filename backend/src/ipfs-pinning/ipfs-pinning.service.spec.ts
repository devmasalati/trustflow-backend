import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IpfsPinningService, IPFS_UNPIN_FAILURE_METRIC } from './ipfs-pinning.service';
import { computeCidV1Raw } from './cid.util';
import { IPFS_EVENTS, PinStatus, ProviderPinStatus } from './ipfs-pinning.types';
import { IpfsPinProvider, PinProviderName } from './providers/ipfs-provider.interface';

function makeProvider(name: PinProviderName): jest.Mocked<IpfsPinProvider> {
  return {
    name,
    isConfigured: false,
    pin: jest.fn().mockResolvedValue(undefined),
    unpin: jest.fn().mockResolvedValue(undefined),
    verify: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<IpfsPinProvider>;
}

describe('IpfsPinningService', () => {
  let pinata: jest.Mocked<IpfsPinProvider>;
  let web3Storage: jest.Mocked<IpfsPinProvider>;
  let infura: jest.Mocked<IpfsPinProvider>;
  let webhookService: { dispatch: jest.Mock };
  let service: IpfsPinningService;

  const CONTENT = Buffer.from('trustflow deliverable payload').toString('base64');
  const CID = computeCidV1Raw(Buffer.from('trustflow deliverable payload'));

  beforeEach(() => {
    pinata = makeProvider(PinProviderName.PINATA);
    web3Storage = makeProvider(PinProviderName.WEB3_STORAGE);
    infura = makeProvider(PinProviderName.INFURA);
    webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    service = new IpfsPinningService([pinata, web3Storage, infura], webhookService as any);
  });

  it('throws on construction with no providers', () => {
    expect(() => new IpfsPinningService([], webhookService as any)).toThrow();
  });

  describe('pinContent', () => {
    it('pins to the first `replicationFactor` providers and reports HEALTHY', async () => {
      const record = await service.pinContent({ content: CONTENT });

      expect(record.cid).toBe(CID);
      expect(record.status).toBe(PinStatus.HEALTHY);
      expect(record.replicationFactor).toBe(2);
      expect(pinata.pin).toHaveBeenCalledWith(CID, Buffer.from(CONTENT, 'base64'));
      expect(web3Storage.pin).toHaveBeenCalled();
      expect(infura.pin).not.toHaveBeenCalled();
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_CREATED,
        expect.objectContaining({ cid: CID }),
      );
    });

    it('rejects when expectedCid does not match the computed content hash', async () => {
      await expect(
        service.pinContent({ content: CONTENT, expectedCid: 'bafkreiwrong' }),
      ).rejects.toThrow(BadRequestException);
      expect(pinata.pin).not.toHaveBeenCalled();
    });

    it('accepts when expectedCid matches the computed content hash', async () => {
      const record = await service.pinContent({ content: CONTENT, expectedCid: CID });
      expect(record.cid).toBe(CID);
    });

    it('fails over to the next provider when one fails to pin', async () => {
      pinata.pin.mockRejectedValue(new Error('pinata unreachable'));

      const record = await service.pinContent({ content: CONTENT });

      expect(record.status).toBe(PinStatus.HEALTHY);
      const pinataEntry = record.providers.find(p => p.provider === PinProviderName.PINATA);
      expect(pinataEntry?.status).toBe(ProviderPinStatus.FAILED);
      expect(pinataEntry?.lastError).toContain('pinata unreachable');

      expect(web3Storage.pin).toHaveBeenCalled();
      expect(infura.pin).toHaveBeenCalled();
    });

    it('fails over when a provider pins but verification does not confirm it', async () => {
      pinata.verify.mockResolvedValueOnce(false);

      const record = await service.pinContent({ content: CONTENT });

      const pinataEntry = record.providers.find(p => p.provider === PinProviderName.PINATA);
      expect(pinataEntry?.status).toBe(ProviderPinStatus.FAILED);
      expect(record.status).toBe(PinStatus.HEALTHY);
    });

    it('reports DEGRADED when fewer than replicationFactor providers succeed', async () => {
      web3Storage.pin.mockRejectedValue(new Error('web3.storage down'));
      infura.pin.mockRejectedValue(new Error('infura down'));

      const record = await service.pinContent({ content: CONTENT });

      expect(record.status).toBe(PinStatus.DEGRADED);
      expect(record.providers.filter(p => p.status === ProviderPinStatus.PINNED)).toHaveLength(1);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_DEGRADED,
        expect.objectContaining({ cid: CID, healthyProviders: 1 }),
      );
    });

    it('throws ServiceUnavailableException and dispatches PIN_FAILED when every provider fails', async () => {
      pinata.pin.mockRejectedValue(new Error('down'));
      web3Storage.pin.mockRejectedValue(new Error('down'));
      infura.pin.mockRejectedValue(new Error('down'));

      await expect(service.pinContent({ content: CONTENT })).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_FAILED,
        expect.objectContaining({ cid: CID }),
      );
    });

    it('clamps replicationFactor to the number of registered providers', async () => {
      const record = await service.pinContent({ content: CONTENT, replicationFactor: 10 });
      expect(record.replicationFactor).toBe(3);
      expect(pinata.pin).toHaveBeenCalled();
      expect(web3Storage.pin).toHaveBeenCalled();
      expect(infura.pin).toHaveBeenCalled();
    });
  });

  describe('reconcile', () => {
    it('detects a lost pin and dispatches PIN_DEGRADED when no original content is retained for retry', async () => {
      await service.pinContent({ content: CONTENT }); // pinned to pinata + web3Storage

      pinata.verify.mockResolvedValue(false); // pinata silently lost the pin

      const record = await service.reconcile(CID);

      // PIN_LOST fired for the provider that dropped the pin
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_LOST,
        expect.objectContaining({ cid: CID, provider: PinProviderName.PINATA }),
      );

      // PIN_DEGRADED fired because healthy count < replicationFactor and content is gone
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_DEGRADED,
        expect.objectContaining({ cid: CID, reason: 'content-not-retained' }),
      );

      // No re-pin attempted — content is not retained
      expect(infura.pin).not.toHaveBeenCalled();
      expect(record.status).toBe(PinStatus.DEGRADED);
    });

    it('dispatches PIN_DEGRADED when a DEGRADED record is reconciled without retained content', async () => {
      // Pin to only one provider (degraded from the start)
      pinata.pin.mockResolvedValue(undefined);
      web3Storage.pin.mockRejectedValue(new Error('web3storage down'));
      infura.pin.mockRejectedValue(new Error('infura down'));

      await service.pinContent({ content: CONTENT });
      jest.clearAllMocks();
      webhookService.dispatch.mockResolvedValue(undefined);

      // All providers pass verify (no new loss) but record is already DEGRADED
      pinata.verify.mockResolvedValue(true);

      const record = await service.reconcile(CID);

      expect(record.status).toBe(PinStatus.DEGRADED);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_DEGRADED,
        expect.objectContaining({ cid: CID, reason: 'content-not-retained' }),
      );
      // No top-up attempted
      expect(web3Storage.pin).not.toHaveBeenCalled();
      expect(infura.pin).not.toHaveBeenCalled();
    });

    it('leaves a fully healthy pin untouched', async () => {
      await service.pinContent({ content: CONTENT });
      jest.clearAllMocks();

      const record = await service.reconcile(CID);

      expect(infura.pin).not.toHaveBeenCalled();
      expect(record.status).toBe(PinStatus.HEALTHY);
    });

    it('throws NotFoundException for an unknown CID', async () => {
      await expect(service.reconcile('bafkreiunknown')).rejects.toThrow();
    });
  });

  describe('unpin', () => {
    it('unpins from every provider currently holding the pin', async () => {
      await service.pinContent({ content: CONTENT });

      const record = await service.unpin(CID);

      expect(pinata.unpin).toHaveBeenCalledWith(CID);
      expect(web3Storage.unpin).toHaveBeenCalledWith(CID);
      expect(infura.unpin).not.toHaveBeenCalled();
      expect(record.status).toBe(PinStatus.UNPINNED);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        IPFS_EVENTS.PIN_REMOVED,
        expect.objectContaining({ cid: CID }),
      );
    });

    describe('when a provider fails to unpin', () => {
      /** Pins to pinata + web3.storage, then makes web3.storage reject its next unpin. */
      async function pinThenFailWeb3Storage(): Promise<Error> {
        await service.pinContent({ content: CONTENT });
        const failure = new Error('429 rate limited');
        web3Storage.unpin.mockRejectedValueOnce(failure);
        return failure;
      }

      async function unpinRejection(): Promise<BadGatewayException> {
        return service.unpin(CID).then(
          () => {
            throw new Error('expected unpin() to reject');
          },
          error => error,
        );
      }

      it('keeps the failed provider PINNED with lastError and answers 502 with per-provider results', async () => {
        await pinThenFailWeb3Storage();

        const error = await unpinRejection();

        expect(error).toBeInstanceOf(BadGatewayException);
        expect(error.getStatus()).toBe(502);
        expect(error.getResponse()).toMatchObject({
          statusCode: 502,
          cid: CID,
          status: PinStatus.UNPINNING,
          failedProviders: [PinProviderName.WEB3_STORAGE],
          providers: [
            expect.objectContaining({
              provider: PinProviderName.PINATA,
              status: ProviderPinStatus.UNPINNED,
            }),
            expect.objectContaining({
              provider: PinProviderName.WEB3_STORAGE,
              status: ProviderPinStatus.PINNED,
              lastError: '429 rate limited',
            }),
          ],
        });

        const record = await service.findByCid(CID);
        expect(record.status).toBe(PinStatus.UNPINNING);
        const failed = record.providers.find(p => p.provider === PinProviderName.WEB3_STORAGE);
        expect(failed).toMatchObject({
          status: ProviderPinStatus.PINNED,
          lastError: '429 rate limited',
        });
      });

      it('does not dispatch ipfs.pin.removed until every provider released the pin', async () => {
        await pinThenFailWeb3Storage();
        webhookService.dispatch.mockClear();

        await unpinRejection();

        expect(webhookService.dispatch).not.toHaveBeenCalledWith(
          IPFS_EVENTS.PIN_REMOVED,
          expect.anything(),
        );
      });

      it('retries only the failed provider on a second DELETE and then completes the removal', async () => {
        await pinThenFailWeb3Storage();
        await unpinRejection();
        webhookService.dispatch.mockClear();

        const record = await service.unpin(CID);

        expect(pinata.unpin).toHaveBeenCalledTimes(1);
        expect(web3Storage.unpin).toHaveBeenCalledTimes(2);
        expect(record.status).toBe(PinStatus.UNPINNED);
        expect(record.providers.every(p => p.status === ProviderPinStatus.UNPINNED)).toBe(true);
        expect(
          record.providers.find(p => p.provider === PinProviderName.WEB3_STORAGE)?.lastError,
        ).toBeUndefined();
        expect(webhookService.dispatch).toHaveBeenCalledTimes(1);
        expect(webhookService.dispatch).toHaveBeenCalledWith(IPFS_EVENTS.PIN_REMOVED, {
          cid: CID,
        });
      });

      it('retains the content so the record is not left unrecoverable', async () => {
        await pinThenFailWeb3Storage();
        await unpinRejection();

        // Content is only dropped once the removal completes.
        expect((service as any).content.has(CID)).toBe(true);
        await service.unpin(CID);
        expect((service as any).content.has(CID)).toBe(false);
      });

      it('counts the failure in metrics', async () => {
        const metrics = { increment: jest.fn() };
        service = new IpfsPinningService(
          [pinata, web3Storage, infura],
          webhookService as any,
          null,
          metrics as any,
        );
        await pinThenFailWeb3Storage();

        await unpinRejection();

        expect(metrics.increment).toHaveBeenCalledWith(IPFS_UNPIN_FAILURE_METRIC, {
          provider: PinProviderName.WEB3_STORAGE,
        });
      });

      it('does not re-pin to already released providers when the record is reconciled', async () => {
        await pinThenFailWeb3Storage();
        await unpinRejection();

        const record = await service.reconcile(CID);

        expect(pinata.pin).toHaveBeenCalledTimes(1);
        expect(record.status).toBe(PinStatus.UNPINNING);
      });

      it('lets a new pin request supersede a half-finished unpin', async () => {
        await pinThenFailWeb3Storage();
        await unpinRejection();

        const record = await service.pinContent({ content: CONTENT });

        expect(record.status).toBe(PinStatus.HEALTHY);
      });

      it('treats the pin as released when the provider reports it absent', async () => {
        await service.pinContent({ content: CONTENT });
        web3Storage.unpin.mockRejectedValueOnce(new Error('404 not found'));
        web3Storage.verify.mockResolvedValueOnce(false);

        const record = await service.unpin(CID);

        expect(record.status).toBe(PinStatus.UNPINNED);
      });

      it('keeps the pin when the provider cannot even confirm it is absent', async () => {
        await pinThenFailWeb3Storage();
        web3Storage.verify.mockRejectedValueOnce(new Error('provider down'));

        await expect(service.unpin(CID)).rejects.toThrow(BadGatewayException);
      });
    });

    it('treats an unregistered provider name as a failure, not a success', async () => {
      const providers = [pinata, web3Storage, infura];
      service = new IpfsPinningService(providers, webhookService as any);
      await service.pinContent({ content: CONTENT });
      providers.splice(providers.indexOf(web3Storage), 1);

      await expect(service.unpin(CID)).rejects.toMatchObject({
        response: expect.objectContaining({ failedProviders: [PinProviderName.WEB3_STORAGE] }),
      });
      const record = await service.findByCid(CID);
      expect(record.status).toBe(PinStatus.UNPINNING);
      const web3Entry = record.providers.find(p => p.provider === PinProviderName.WEB3_STORAGE);
      expect(web3Entry).toMatchObject({
        status: ProviderPinStatus.PINNED,
        lastError: 'Provider web3.storage is not registered',
      });
    });

    it('does not dispatch ipfs.pin.removed again for an already unpinned record', async () => {
      await service.pinContent({ content: CONTENT });
      await service.unpin(CID);
      webhookService.dispatch.mockClear();

      const record = await service.unpin(CID);

      expect(record.status).toBe(PinStatus.UNPINNED);
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('findAll / findByCid', () => {
    it('lists and retrieves pin records', async () => {
      await service.pinContent({ content: CONTENT });

      expect(await service.findAll()).toHaveLength(1);
      expect((await service.findByCid(CID)).cid).toBe(CID);
      await expect(service.findByCid('bafkreiunknown')).rejects.toThrow();
    });
  });
});
