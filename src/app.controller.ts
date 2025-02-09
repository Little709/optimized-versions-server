import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import { AppService, Job } from './app.service';
import { log } from 'console';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private logger: Logger,
  ) {}

  @Get('statistics')
  async getStatistics() {
    return this.appService.getStatistics();
  }

  @Post('optimize-version')
  async downloadAndCombine(
    @Body('url') url: string,
    @Body('fileExtension') fileExtension: string,
    @Body('deviceId') deviceId: string,
    @Body('itemId') itemId: string,
    @Body('item') item: any,
  ): Promise<{ id: string }> {
    this.logger.log(`Optimize request for URL: ${url.slice(0, 50)}...`);

    let jellyfinUrl = process.env.JELLYFIN_URL;

    let finalUrl: string;
    if (jellyfinUrl) {
      jellyfinUrl = jellyfinUrl.replace(/\/$/, '');
      // If JELLYFIN_URL is set, use it to replace the base of the incoming URL
      const parsedUrl = new URL(url);
      finalUrl = new URL(
        parsedUrl.pathname + parsedUrl.search,
        jellyfinUrl,
      ).toString();
    } else {
      // If JELLYFIN_URL is not set, use the incoming URL as is
      finalUrl = url;
    }
    
    const id = await this.appService.downloadAndCombine(
      finalUrl,
      fileExtension,
      deviceId,
      itemId,
      item,
    );
    return { id };
  }

  @Get('job-status/:id')
  async getActiveJob(@Param('id') id: string): Promise<Job | null> {
    return this.appService.getJobStatus(id);
  }

  @Post('start-job/:id')
  async startJob(@Param('id') id: string): Promise<{ message: string }> {
    this.logger.log(`Manual start request for job: ${id}`);

    try {
      const result = await this.appService.manuallyStartJob(id);
      if (result) {
        return { message: 'Job started successfully' };
      } else {
        throw new HttpException(
          'Job not found or already started',
          HttpStatus.BAD_REQUEST,
        );
      }
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Delete('cancel-job/:id')
  async cancelJob(@Param('id') id: string) {
    this.logger.log(`Cancellation request for job: ${id}`);
    // this.appService.completeJob(id);
    const result = this.appService.cancelJob(id);
    if (result) {
      return { message: 'Job cancelled successfully' };
    } else {
      return { message: 'Job not found or already completed' };
    }
  }

  @Get('all-jobs')
  async getAllJobs(@Query('deviceId') deviceId?: string) {
    return this.appService.getAllJobs(deviceId);
  }

  @Get('download/:id')
  async downloadTranscodedFile(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const filePath = this.appService.getTranscodedFilePath(id);

    if (!filePath) {
      throw new NotFoundException('File not found or job not completed');
    }

    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'video/x-mastroka');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=transcoded_${id}.mkv`,
    );
    let chunkSize = Number(process.env.CHUNK_SIZE_IN_BYTES) || 262144;

    const fileStream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
    
    this.logger.log(`Download started for ${filePath}`)

    let bytesSent = 0;
    let lastLoggedTime = Date.now();
    const throttleInterval = 15 * 1000; // log at most once per 15 seconds
    const startTime = Date.now();
  
    fileStream.on('data', (chunk) => {
      bytesSent += chunk.length;
      const now = Date.now();
  
      if (now - lastLoggedTime >= throttleInterval) {
        // Calculate elapsed time in seconds
        const elapsedSeconds = (now - startTime) / 1000;
        // Calculate throughput in bytes/sec and convert to MB/s
        const speedBytesPerSec = bytesSent / elapsedSeconds;
        const speedMBps = speedBytesPerSec / (1024 * 1024);
        // Estimate remaining time (in seconds)
        const remainingBytes = stat.size - bytesSent;
        const estimatedRemainingSecs = speedBytesPerSec > 0
          ? remainingBytes / speedBytesPerSec
          : 0;
        // Calculate percentage complete
        const percentage = (bytesSent / stat.size) * 100;
        
        this.logger.log(
          `Download progress: ${percentage.toFixed(2)}% | ` +
          `${speedMBps.toFixed(2)} MB/s | ` +
          `~${estimatedRemainingSecs.toFixed(0)} sec remaining`
        );
        
        lastLoggedTime = now;
      }
    });

    return new Promise((resolve, reject) => {
      fileStream.pipe(res);

      fileStream.on('end', () => {
        // File transfer completed
        this.logger.log(`File transfer ended for: ${filePath}`)
        
        resolve(null);
      });

      
      fileStream.on('error', (err) => {
        // Handle errors during file streaming
        this.logger.error(`Error streaming file ${filePath}: ${err.message}`);
        reject(err);
      });
    });
  }


  @Delete('delete-cache')
  async deleteCache() {
    this.logger.log('Cache deletion request');
    return this.appService.deleteCache();
  }
}
