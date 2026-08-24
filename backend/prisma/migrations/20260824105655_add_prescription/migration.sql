-- Schedule H prescription register (FR-MED-12, PRD Q4).
--
-- Medicine.isScheduledH has been displayed at the POS since 1.0.0 and gated
-- nothing: the flag was shown to the cashier and the sale went through either
-- way. SECURITY.md said so plainly — the system did not by itself satisfy a
-- prescription-record obligation.
--
-- What Q4 settled. Rule 65(11) of the Drugs and Cosmetics Rules lets a pharmacy
-- record the particulars of a prescription in a register instead of retaining
-- the paper. Most of those particulars already exist here: date of supply, the
-- drugs, the quantities and the dispensing pharmacist are the invoice and its
-- lines. What was missing is the prescriber, the prescription's own date, and
-- the patient's name — nullable Invoice.customerId means a Schedule H walk-in
-- otherwise leaves no patient at all.
--
-- One row per invoice, not per line: a customer hands over one prescription
-- covering every Schedule H item on the bill. A bill needing two has to be
-- split, which is what happens at the counter anyway.
--
-- No image column. The rules permit the register in lieu of the paper, this
-- stack has no file storage, and a scan would be a second copy of
-- patient-identifying data carrying its own retention and erasure obligations.
-- Adding one later does not disturb these columns.
--
-- patientName is personal data and is anonymised with its customer by the
-- erasure path (PRD Q6, docs/03 section 8).

-- CreateTable
CREATE TABLE "Prescription" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "prescriberName" TEXT NOT NULL,
    "prescriberRegNo" TEXT NOT NULL,
    "prescribedOn" TIMESTAMP(3) NOT NULL,
    "patientName" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Prescription_invoiceId_key" ON "Prescription"("invoiceId");

-- CreateIndex
CREATE INDEX "Prescription_prescriberRegNo_idx" ON "Prescription"("prescriberRegNo");

-- CreateIndex
CREATE INDEX "Prescription_prescribedOn_idx" ON "Prescription"("prescribedOn");

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
