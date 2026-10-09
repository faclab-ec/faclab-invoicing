import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  QueryCommandInput,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

import { Invoice, InvoiceStatus } from '../../domain/invoice';
import { ConcurrentUpdateError, InvoiceRepository } from '../../domain/repository';
import { fromInvoiceRecord, InvoiceRecord, toInvoiceRecord } from './invoice.mapper';

const IN_FLIGHT_STATUSES = [
  InvoiceStatus.PENDING,
  InvoiceStatus.CREATED,
  InvoiceStatus.SIGNED,
  InvoiceStatus.SENT,
];

export class DynamoInvoiceRepository implements InvoiceRepository {
  constructor(
    private docClient: DynamoDBDocumentClient,
    private tableName: string,
  ) {}

  async createInvoice(invoice: Invoice): Promise<boolean> {
    const version = invoice.version + 1;
    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...toInvoiceRecord(invoice), version },
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
    invoice.version = version;
    return true;
  }

  async updateInvoice(invoice: Invoice): Promise<Invoice> {
    const expected = invoice.version;
    // Invoices saved before versioning have no `version` attribute
    const condition =
      expected === 0
        ? 'attribute_not_exists(#version) OR #version = :expected'
        : '#version = :expected';
    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...toInvoiceRecord(invoice), version: expected + 1 },
          ConditionExpression: condition,
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':expected': expected },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ConcurrentUpdateError(invoice.id);
      }
      throw error;
    }
    invoice.version = expected + 1;
    return invoice;
  }

  async getInvoiceById(id: string): Promise<Invoice | null> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { id },
        ConsistentRead: true,
      }),
    );
    return result.Item ? fromInvoiceRecord(result.Item as InvoiceRecord) : null;
  }

  async findAll(): Promise<Invoice[]> {
    const items: InvoiceRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.docClient.send(
        new ScanCommand({ TableName: this.tableName, ExclusiveStartKey: startKey }),
      );
      items.push(...((result.Items ?? []) as InvoiceRecord[]));
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return items.map(fromInvoiceRecord);
  }

  async findBySaleId(saleId: string): Promise<Invoice[]> {
    return this.queryAll({
      TableName: this.tableName,
      IndexName: 'SaleIdIndex',
      KeyConditionExpression: 'saleId = :saleId',
      ExpressionAttributeValues: { ':saleId': saleId },
    });
  }

  async findInFlight(): Promise<Invoice[]> {
    const groups = await Promise.all(
      IN_FLIGHT_STATUSES.map((status) =>
        this.queryAll({
          TableName: this.tableName,
          IndexName: 'StatusIndex',
          KeyConditionExpression: '#status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': status },
        }),
      ),
    );
    return groups.flat();
  }

  private async queryAll(input: QueryCommandInput): Promise<Invoice[]> {
    const items: InvoiceRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.docClient.send(
        new QueryCommand({ ...input, ExclusiveStartKey: startKey }),
      );
      items.push(...((result.Items ?? []) as InvoiceRecord[]));
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return items.map(fromInvoiceRecord);
  }
}
