// Encodes raw BGRA frames from stdin into an H.264 MP4 using AVFoundation (macOS).
// Used by render-sample.js. Frequent keyframes keep scrubbing with the scroll wheel smooth.
//
//   encode-video out.mp4 width height fps bitrate  < frames.bgra

import AVFoundation
import CoreVideo
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 6, let width = Int(args[2]), let height = Int(args[3]),
      let fps = Int32(args[4]), let bitrate = Int(args[5]) else {
    fail("usage: encode-video out.mp4 width height fps bitrate")
}

let outURL = URL(fileURLWithPath: args[1])
try? FileManager.default.removeItem(at: outURL)

guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { fail("cannot create writer") }

let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoMaxKeyFrameIntervalKey: 4,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: false,
    ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
    ]
)
writer.add(input)
guard writer.startWriting() else { fail("startWriting failed: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)

let frameBytes = width * height * 4
let stdin = FileHandle.standardInput

func readExactly(_ count: Int) -> Data? {
    var data = Data(capacity: count)
    while data.count < count {
        let chunk = stdin.readData(ofLength: count - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

var index: Int64 = 0
while let frame = readExactly(frameBytes) {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    guard let pool = adaptor.pixelBufferPool else { fail("no pixel buffer pool") }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
    guard let pixelBuffer = buffer else { fail("cannot allocate a pixel buffer") }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    let base = CVPixelBufferGetBaseAddress(pixelBuffer)!
    let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
    frame.withUnsafeBytes { source in
        for row in 0..<height {
            memcpy(base + row * stride, source.baseAddress! + row * width * 4, width * 4)
        }
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

    if !adaptor.append(pixelBuffer, withPresentationTime: CMTime(value: index, timescale: fps)) {
        fail("append failed: \(String(describing: writer.error))")
    }
    index += 1
}

input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fail("finish failed: \(String(describing: writer.error))") }
