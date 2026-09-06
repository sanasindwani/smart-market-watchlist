-- CreateTable
CREATE TABLE "Symbol" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isIndex" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Symbol_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "Bar" (
    "symbol" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Bar_pkey" PRIMARY KEY ("symbol","date")
);

-- CreateTable
CREATE TABLE "Quote" (
    "symbol" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "sources" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "SymbolStat" (
    "symbol" TEXT NOT NULL,
    "dailyVol" DOUBLE PRECISION NOT NULL,
    "idioVol" DOUBLE PRECISION NOT NULL,
    "avgVolume" DOUBLE PRECISION NOT NULL,
    "high52w" DOUBLE PRECISION NOT NULL,
    "low52w" DOUBLE PRECISION NOT NULL,
    "lastClose" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SymbolStat_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "CorporateAction" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ratio" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,

    CONSTRAINT "CorporateAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymbolEvent" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "magnitude" DOUBLE PRECISION NOT NULL,
    "detail" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SymbolEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rank" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("userId","symbol")
);

-- CreateTable
CREATE TABLE "Baseline" (
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "indexPrice" DOUBLE PRECISION,

    CONSTRAINT "Baseline_pkey" PRIMARY KEY ("userId","symbol")
);

-- CreateTable
CREATE TABLE "Acknowledgement" (
    "userId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Acknowledgement_pkey" PRIMARY KEY ("userId","dedupeKey")
);

-- CreateTable
CREATE TABLE "AlertLevel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "direction" TEXT NOT NULL,

    CONSTRAINT "AlertLevel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bar_symbol_date_idx" ON "Bar"("symbol", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CorporateAction_symbol_date_type_key" ON "CorporateAction"("symbol", "date", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SymbolEvent_dedupeKey_key" ON "SymbolEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "SymbolEvent_symbol_at_idx" ON "SymbolEvent"("symbol", "at");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "WatchlistItem_symbol_idx" ON "WatchlistItem"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "AlertLevel_userId_symbol_value_direction_key" ON "AlertLevel"("userId", "symbol", "value", "direction");

-- AddForeignKey
ALTER TABLE "Bar" ADD CONSTRAINT "Bar_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Symbol"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Symbol"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SymbolStat" ADD CONSTRAINT "SymbolStat_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Symbol"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorporateAction" ADD CONSTRAINT "CorporateAction_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Symbol"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SymbolEvent" ADD CONSTRAINT "SymbolEvent_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Symbol"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Symbol"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Baseline" ADD CONSTRAINT "Baseline_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acknowledgement" ADD CONSTRAINT "Acknowledgement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertLevel" ADD CONSTRAINT "AlertLevel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
