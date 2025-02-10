import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { CACHE_DIR } from './constants';
import { FileRemoval } from './cleanup/removalUtils';
import * as kill from 'tree-kill';

export interface Job {
  id: string;
  status: 'queued' | 'optimizing' | 'pending downloads limit' | 'completed' | 'failed' | 'cancelled' | 'ready-for-removal';
  progress: number;
  outputPath: string;
  inputUrl: string;
  deviceId: string;
  itemId: string;
  timestamp: Date;
  size: number;
  item: any;
  speed?: number;
  isDirectPlay: boolean;
  subtitleIncluded: boolean;
}

@Injectable()
export class AppService {
  private activeJobs: Job[] = [];
  private optimizationHistory: Job[] = [];
  private ffmpegProcesses: Map<string, ChildProcess> = new Map();
  private videoDurations: Map<string, number> = new Map();
  private jobQueue: string[] = [];
  private maxConcurrentJobs: number;
  private maxCachedPerUser: number;
  private cacheDir: string;
  private immediateRemoval: boolean;
  private ApiKey: string;
  private jellyfinURL: string
  private forceAllDownloadsToH265: boolean;
  
  constructor(
    private logger: Logger,
    private configService: ConfigService,
    private readonly fileRemoval: FileRemoval

  ) {
    this.cacheDir = CACHE_DIR;
    this.maxConcurrentJobs = this.configService.get<number>(
      'MAX_CONCURRENT_JOBS',
      1,
    );
    this.maxCachedPerUser = this.configService.get<number>(
      'MAX_CACHED_PER_USER',
      10,
    );
    this.immediateRemoval = this.configService.get<string>('REMOVE_FILE_AFTER_RIGHT_DOWNLOAD', 'false').toLowerCase() === 'true';

    this.ApiKey = this.configService.get<string>(
      'JELLYFIN_API_KEY',
    );
    this.jellyfinURL = this.configService.get<string>(
      'JELLYFIN_URL',
    );

    this.forceAllDownloadsToH265 = this.configService.get<string>('FORCE_ALL_DOWNLOADS_TO_H265', 'false').toLowerCase() === 'true';
  }

  urlEditor(url){
    if (this.forceAllDownloadsToH265 === true){
      url = url.replace(/VideoCodec=h264/g, "VideoCodec=h265");
    }
    return url
  }

  async downloadAndCombine(
    url: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fileExtension: string,
    deviceId: string,
    itemId: string,
    item: any,
  ): Promise<string> {
    const jobId = uuidv4();
    const outputPath = path.join(this.cacheDir, `combined_${jobId}.mkv`);
    this.logger.log(
      `Queueing job ${jobId.padEnd(36)} | URL: ${(url.slice(0, 50) + '...').padEnd(53)} | Path: ${outputPath}`,
    );

    const isTranscoded = url.includes("TranscodeReasons=")
    const hasSubs = url.includes("SubtitleMethod=")

    // this.logger.log(`url: ${url}`)
    url = this.urlEditor(url)
    // Improved logging with structured message
    // this.logger.debug({
    //   message: "Transcoding Check",
    //   isTranscoded: isTranscoded,
    //   url: url,
    // });

    this.activeJobs.push({
      id: jobId,
      status: 'queued',
      progress: 0,
      outputPath,
      inputUrl: url,
      itemId,
      item,
      deviceId,
      timestamp: new Date(),
      size: 0,
      isDirectPlay: !isTranscoded,
      subtitleIncluded: hasSubs
    });
    this.jobQueue.push(jobId);
    this.checkQueue(); // Check if we can start the job immediately

    return jobId;
  }

  getJobStatus(jobId: string): Job | null {
    const job = this.activeJobs.find((job) => job.id === jobId);
    return job || null;
  }

  getAllJobs(deviceId?: string | null): Job[] {
    if (!deviceId) {
      return this.activeJobs;
    }
    return this.activeJobs.filter((job) => job.deviceId === deviceId && job.status !== 'ready-for-removal');
  }

  async deleteCache(): Promise<{ message: string }> {
    try {
      const files = await fsPromises.readdir(this.cacheDir);
      await Promise.all(
        files.map((file) => fsPromises.unlink(path.join(this.cacheDir, file))),
      );
      return {
        message: 'Cache deleted successfully',
      };
    } catch (error) {
      this.logger.error('Error deleting cache:', error);
      throw new InternalServerErrorException('Failed to delete cache');
    }
  }

  removeJob(jobId: string): void {
    this.activeJobs = this.activeJobs.filter(job => job.id !== jobId);
    this.logger.log(`Job ${jobId} removed.`);
  }

  cancelJob(jobId: string): boolean {
    this.completeJob(jobId);
    const job = this.activeJobs.find(job => job.id === jobId);
    const process = this.ffmpegProcesses.get(jobId);
  
    const finalizeJobRemoval = () => {
      if (job) {
        this.jobQueue = this.jobQueue.filter(id => id !== jobId);
        if (this.immediateRemoval === true || job.progress < 100) {
          this.fileRemoval.cleanupReadyForRemovalJobs([job]);
          this.activeJobs = this.activeJobs.filter(activeJob => activeJob.id !== jobId);
          this.logger.log(`Job ${jobId} removed`);
        }
        else{
          this.logger.log('Immediate removal is not allowed, cleanup service will take care in due time')
        }
      }
      this.activeJobs
        .filter((nextjob) => nextjob.deviceId === job.deviceId && nextjob.status === 'pending downloads limit')
        .forEach((job) => job.status = 'queued')
      this.checkQueue();
    };

    if (process) {
      try {
        this.logger.log(`Attempting to kill process tree for PID ${process.pid}`);
        new Promise<void>((resolve, reject) => {
          kill(process.pid, 'SIGINT', (err) => {
            if (err) {
              this.logger.error(`Failed to kill process tree for PID ${process.pid}: ${err.message}`);
              reject(err);
            } else {
              this.logger.log(`Successfully killed process tree for PID ${process.pid}`);
              resolve();
              finalizeJobRemoval()
            }
          });
        });
      } catch (err) { 
        this.logger.error(`Error terminating process for job ${jobId}: ${err.message}`);
      }
      this.ffmpegProcesses.delete(jobId);
      return true;
    } else {
      finalizeJobRemoval();
      return true;
    }
  }
  
  completeJob(jobId: string):void{
    const job = this.activeJobs.find((job) => job.id === jobId);

    if (job) {
      job.status = 'ready-for-removal';
      job.timestamp = new Date()
      this.logger.log(`Job ${jobId} marked as completed and ready for removal.`);
    } else {
      this.logger.warn(`Job ${jobId} not found. Cannot mark as completed.`);
    }
  }

  cleanupJob(jobId: string): void {
    const job = this.activeJobs.find((job) => job.id === jobId);
    this.activeJobs = this.activeJobs.filter((job) => job.id !== jobId);
    this.ffmpegProcesses.delete(jobId);
    this.videoDurations.delete(jobId);
  }

  getTranscodedFilePath(jobId: string): string | null {
    const job = this.activeJobs.find((job) => job.id === jobId);
    if (job && job.status === 'completed') {
      return job.outputPath;
    }
    return null;
  }

  getMaxConcurrentJobs(): number {
    return this.maxConcurrentJobs;
  }

  async getStatistics() {
    const cacheSize = await this.getCacheSize();
    const totalTranscodes = this.getTotalTranscodes();
    const activeJobs = this.getActiveJobs();
    const completedJobs = this.getCompletedJobs();
    const uniqueDevices = this.getUniqueDevices();

    return {
      cacheSize,
      totalTranscodes,
      activeJobs,
      completedJobs,
      uniqueDevices,
    };
  }

  async manuallyStartJob(jobId: string): Promise<boolean> {
    const job = this.activeJobs.find((job) => job.id === jobId);

    if (!job || job.status !== 'queued') {
      return false;
    }

    this.startJob(jobId);
    return true;
  }

  private async getCacheSize(): Promise<string> {
    const cacheSize = await this.getDirectorySize(this.cacheDir);
    return this.formatSize(cacheSize);
  }

  private async getDirectorySize(directory: string): Promise<number> {
    const files = await fs.promises.readdir(directory);
    const stats = await Promise.all(
      files.map((file) => fs.promises.stat(path.join(directory, file))),
    );

    return stats.reduce((accumulator, { size }) => accumulator + size, 0);
  }

  private formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  private getTotalTranscodes(): number {
    return this.activeJobs.length;
  }

  private getActiveJobs(): number {
    return this.activeJobs.filter((job) => job.status === 'optimizing').length;
  }

  private getCompletedJobs(): number {
    return this.activeJobs.filter((job) => job.status === 'ready-for-removal').length;
  }

  private isDeviceIdInOptimizeHistory(job:Job){
    const uniqueDeviceIds: string[] = [...new Set(this.optimizationHistory.map((job: Job) => job.deviceId))];
    const result = uniqueDeviceIds.includes(job.deviceId); // Check if job.deviceId is in uniqueDeviceIds
    this.logger.log(`Device ID ${job.deviceId} is ${result ? 'in' : 'not in'} the finished jobs. Optimizing ${result ? 'Allowed' : 'not Allowed'}`);
    return result
  }

  private getActiveJobDeviceIds(): string[]{
    const uniqueDeviceIds: string[] = [
      ...new Set(
        this.activeJobs
          .filter((job: Job) => job.status === 'queued') // Filter jobs with status 'queued'
          .map((job: Job) => job.deviceId) // Extract deviceId
      )
    ];
    return uniqueDeviceIds
  }
  
  private handleOptimizationHistory(job: Job): void{
    // create a finished jobs list to make sure every device gets equal optimizing time
    this.optimizationHistory.push(job) // push the newest job to the finished jobs list
    const amountOfActiveDeviceIds = this.getActiveJobDeviceIds().length // get the amount of active queued job device ids
    while(amountOfActiveDeviceIds <= this.optimizationHistory.length && this.optimizationHistory.length > 0){ // the finished jobs should always be lower than the amount of active jobs. This is to push out the last deviceid: FIFO
      this.optimizationHistory.shift() // shift away the oldest job.
    }
    this.logger.log(`${this.optimizationHistory.length} deviceIDs have recently finished a job`)
  }

  private getUniqueDevices(): number {
    const devices = new Set(this.activeJobs.map((job) => job.deviceId));
    return devices.size;
  }

  private checkQueue() {
    let runningJobs = this.activeJobs.filter((job) => job.status === 'optimizing').length;
  
    this.logger.log(
      `${runningJobs} active jobs running and ${this.jobQueue.length} items in the queue`,
    );
  
    for (const index in this.jobQueue) {
      const nextJobId = this.jobQueue[index]; // Access job ID by index
      let nextJob: Job = this.activeJobs.find((job) => job.id === nextJobId);
      const isRunningDirectPlay = this.activeJobs.some(
        (job) => job.status === 'optimizing' && job.isDirectPlay === true
      );
      if(runningJobs == 1 && (nextJob.isDirectPlay === false || isRunningDirectPlay)){
        continue // direct play should always be possible, look for the first directplay item in queue and allow that one.
      }
      else if (runningJobs >= this.maxConcurrentJobs) {
        break; // Stop if max concurrent jobs are reached
      }
      
      if (!this.userTooManyCachedItems(nextJobId) ) {
        nextJob.status = 'pending downloads limit'
        // Skip this job if user cache limits are reached
        continue;
      }
      if(this.isDeviceIdInOptimizeHistory(nextJob)){
        // Skip this job if deviceID is in the recently finished jobs
        continue
      }
      // Start the job and remove it from the queue
      this.startJob(nextJobId);
      this.jobQueue.splice(Number(index), 1); // Remove the started job from the queue
      runningJobs++; // Increment running jobs
    }
  }

  private userTooManyCachedItems(jobid): boolean{
    if(this.maxCachedPerUser == 0){
      return false
    }
    const theNewJob: Job = this.activeJobs.find((job) => job.id === jobid)
    let completedUserJobs = this.activeJobs.filter((job) => (job.status === "completed" || job.status === 'optimizing') && job.deviceId === theNewJob.deviceId)
    if((completedUserJobs.length >= this.maxCachedPerUser)){
      this.logger.log(`Waiting for items to be downloaded - device ${theNewJob.deviceId} has ${completedUserJobs.length} downloads waiting `);
      return false
    }
    else{
      this.logger.log(`Optimizing - device ${theNewJob.deviceId} has ${completedUserJobs.length} downloads waiting`);
      return true
    }  
  }

  private async startJob(jobId: string) { // Add "async" to the function
    const job = this.activeJobs.find((job) => job.id === jobId);
    if (job) {
        job.status = 'optimizing';
        this.handleOptimizationHistory(job);

        try {
            await this.getVideoDuration(job.inputUrl, jobId);
            // Await the Promise to ensure subtitles are loaded before FFmpeg starts
            const ffmpegArgs = await this.getFfmpegArgs(job.inputUrl, job.itemId, job.outputPath,job.subtitleIncluded);
            // this.logger.log(ffmpegArgs)
            // Now FFmpeg will start with the correct arguments
            await this.startFFmpegProcess(jobId, ffmpegArgs)
            .finally(() => {this.checkQueue()});

        } catch (error) {
            this.logger.error(`Error processing job ${jobId}:`, error);
        }
        this.logger.log(`Started job ${jobId}`);
    }
  }

  private async getFfmpegArgs(
    inputUrl: string,
    mediaSourceId: string,
    outputPath: string,
    subtitleIncluded: boolean
  ): Promise<string[]> {
    const args: string[] = ['-i', inputUrl];
    
    if (subtitleIncluded) {
      this.logger.debug('Subtitles already included, skipping subtitle handling.');
      args.push(
        '-map', '0:v?',
        '-map', '0:a?',
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-f', 'matroska',
        outputPath
      );
      this.logger.debug(args);
      return args;
    }
  
    // Get all subtitles and split into internal and external
    const allSubs = await this.getAvailableSubtitles(mediaSourceId);
    const hasInternalSubs = allSubs.some(sub => !sub.isExternal);
    let internalSubsIndex = -1;
  
    if (hasInternalSubs) {
      const originalFilePath = await this.fetchOriginalFilePath(mediaSourceId);
      if (originalFilePath) {
        args.push('-i', originalFilePath);
        internalSubsIndex = 1; // Input #1 is the internal subtitle source
      }
    }
  
    // Build external subtitle list, warn if a file path is missing
    const externalSubs: { path: string; language: string }[] = [];
    for (const sub of allSubs) {
      if (!sub.isExternal) continue;
      if (!sub.filePath) {
        this.logger.warn(`Skipping missing external subtitle: ${sub.filePath}`);
        continue;
      }
      externalSubs.push({ path: sub.filePath, language: sub.language || 'und' });
    }
  
    // Add each external subtitle as an input
    externalSubs.forEach(sub => args.push('-i', sub.path));
  
    // Map video and audio from primary input (#0)
    args.push('-map', '0:v?', '-map', '0:a?');
  
    // Map internal subtitles if available
    if (internalSubsIndex >= 0) {
      args.push('-map', `${internalSubsIndex}:s?`);
    }
  
    // External subtitle inputs start at index 2 if internal subs exist, else 1
    const firstExtIndex = internalSubsIndex >= 0 ? 2 : 1;
    externalSubs.forEach((sub, i) => {
      args.push('-map', `${firstExtIndex + i}:0`);
      args.push(`-metadata:s:s:${i}`, `language=${sub.language}`);
    });
  
    // Copy streams and output as matroska
    args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'copy', '-f', 'matroska', outputPath);
  
    this.logger.debug(args);
    return args;
  }
  
  private async fetchOriginalFilePath(mediaSourceId: string): Promise<string | null> {
    const url = `${this.jellyfinURL}/Items/${mediaSourceId}/PlaybackInfo?api_key=${this.ApiKey}`;
    try {
      const response = await fetch(url);
      const data = await response.json();
      const path = data.MediaSources?.[0]?.Path;
      if (path) {
        this.logger.debug(`Original file path: ${path}`);
        return path;
      }
    } catch (err) {
      this.logger.warn(`Could not fetch original file for ID ${mediaSourceId}: ${err}`);
    }
    return null;
  }
    
  private async getAvailableSubtitles(
    mediaSourceId: string
  ): Promise<Array<{ 
    index: number;
    language: string;
    filePath?: string;    // might be undefined for internal subs
    isExternal: boolean;
  }>> {
    const subtitlesApiUrl = `${this.jellyfinURL}/Items/${mediaSourceId}/PlaybackInfo?api_key=${this.ApiKey}`;
    this.logger.log(`Fetching subtitles from: ${subtitlesApiUrl}`);
    
    try {
      const response = await fetch(subtitlesApiUrl);
      const data = await response.json();
      // this.logger.debug(data)
      if (!data.MediaSources || data.MediaSources.length === 0) {
        throw new Error("No media sources found.");
      }
  
      const mediaSource = data.MediaSources[0];
      const pathTranslator = process.env.PATH_TRANSLATOR || "";
      mediaSource.Path = path.join(pathTranslator,mediaSource.Path)
      // Now we filter only by Type === "Subtitle", no longer ignoring .IsExternal
      const allSubtitleStreams = (mediaSource?.MediaStreams || [])
      .filter((stream: any) => stream.Type === "Subtitle")
      .map((stream: any) => {
        const isExternal = !!stream.IsExternal;
        stream.Path = path.join(pathTranslator,stream.Path)
        return {
          index: stream.Index,
          language: stream.Language || 'und',
          // For external subs, use the subtitle's own Path
          // For internal subs, use the MediaSource's overall file path
          filePath: isExternal ? stream.Path : mediaSource.Path,
          isExternal
        };
      });
  
      return allSubtitleStreams;
    } catch (error) {
      this.logger.error('Error fetching subtitles:', error);
      return [];
    }
  }

  private async startFFmpegProcess(
    jobId: string,
    ffmpegArgs: string[],
  ): Promise<void> {
    try {

      return new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe']});
        let ffmpegError = '';
        ffmpegProcess.stderr.on('data', data => {
          ffmpegError += data.toString();
        });
        this.ffmpegProcesses.set(jobId, ffmpegProcess);

        ffmpegProcess.stderr.on('data', (data) => {
          this.updateProgress(jobId, data.toString());
        });
        
        ffmpegProcess.on('close', async (code) => {
          this.ffmpegProcesses.delete(jobId);
          this.videoDurations.delete(jobId);

          const job = this.activeJobs.find((job) => job.id === jobId);
          if (!job) {
            resolve();
            return;
          }

          if (code === 0) {
            job.status = 'completed';
            job.progress = 100;
            // Update the file size
            try {
              const stats = await fsPromises.stat(job.outputPath);
              job.size = stats.size;
            } catch (error) {
              this.logger.error(
                `Error getting file size for job ${jobId}: ${error.message}`,
              );
            }
            this.logger.log(
              `Job ${jobId} completed successfully. Output: ${job.outputPath}, Size: ${this.formatSize(job.size || 0)}`,
            );
            resolve();
          } else {
            job.status = 'failed';
            job.progress = 0;
            this.logger.error(
              `Job ${jobId} failed with exit code ${code}. Error: ${ffmpegError.trim()}. Input URL: ${job.inputUrl}`
            );
            // reject(new Error(`FFmpeg process failed with exit code ${code}`));
          }
        });

        ffmpegProcess.on('error', (error) => {
          this.logger.error(
            `FFmpeg process error for job ${jobId}: ${error.message}`,
          );
          // reject(error);
        });
      });
    } catch (error) {
      this.logger.error(`Error processing job ${jobId}: ${error.message}`);
      const job = this.activeJobs.find((job) => job.id === jobId);
      if (job) {
        job.status = 'failed';
      }
    }
  }


  private async getVideoDuration(
    inputUrl: string,
    jobId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputUrl,
      ]);

      let output = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          this.videoDurations.set(jobId, duration);
          resolve();
        } else {
          reject(new Error(`ffprobe process exited with code ${code}`));
        }
      });
    });
  }

  private updateProgress(jobId: string, ffmpegOutput: string): void {
    const progressMatch = ffmpegOutput.match(
      /time=(\d{2}):(\d{2}):(\d{2})\.\d{2}/,
    );
    const speedMatch = ffmpegOutput.match(/speed=(\d+\.?\d*)x/);

    if (progressMatch) {
      const [, hours, minutes, seconds] = progressMatch;
      const currentTime =
        parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);

      const totalDuration = this.videoDurations.get(jobId);
      if (totalDuration) {
        const progress = Math.min((currentTime / totalDuration) * 100, 99.9);
        const job = this.activeJobs.find((job) => job.id === jobId);
        if (job) {
          job.progress = Math.max(progress, 0);

          // Update speed if available
          if (speedMatch) {
            const speed = parseFloat(speedMatch[1]);
            job.speed = Math.max(speed, 0);
          }
        }
      }
    }
  }
}
