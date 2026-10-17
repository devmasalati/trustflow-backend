import { Module, forwardRef } from '@nestjs/common';
import { OutboxController } from './outbox.controller';
import { OutboxService } from './outbox.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxEventDispatcher } from './outbox-event-dispatcher.service';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [MonitoringModule, forwardRef(() => WebhookModule)],
  controllers: [OutboxController],
  providers: [
    OutboxService,
    OutboxPublisherService,
    OutboxRelayService,
    OutboxEventDispatcher,
  ],
  exports: [OutboxService, OutboxPublisherService, OutboxEventDispatcher],
})
export class OutboxModule {}
